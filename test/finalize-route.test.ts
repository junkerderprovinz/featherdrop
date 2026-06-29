import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point DATA_DIR/CONFIG_DIR at throw-away temp dirs BEFORE any module that
// reads lib/config (config reads them at import time via top-level `process.env`).
const testDataDir = mkdtempSync(join(tmpdir(), "fd-fin-"));
const testUploadsDir = join(testDataDir, "uploads");
const testTmpDir = join(testDataDir, "tmp");
mkdirSync(testUploadsDir, { recursive: true });
mkdirSync(testTmpDir, { recursive: true });

process.env.DATA_DIR = testDataDir;
process.env.CONFIG_DIR = testDataDir;
// Disable server-side encryption so the v1 path does a plain rename (simpler
// to test without the age crypto machinery).
process.env.ENCRYPT_UPLOADS = "false";

// better-sqlite3 is a native addon; skip when it is not built locally.
let dbReason: string | boolean = false;
try {
  const Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  dbReason = "better-sqlite3 native addon not built";
}

// Dynamic-import the route AFTER env vars are set and DB availability is known.
type RouteModule = typeof import("../app/api/finalize/route");
let routeMod: RouteModule | undefined;
type DbModule = typeof import("../server/db");
let db: DbModule | undefined;

if (!dbReason) {
  routeMod = await import("../app/api/finalize/route");
  db = await import("../server/db");
  db.initDb();
}

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Create a fake completed tus upload in TMP_DIR (binary + sidecar). */
function makeFakeTusUpload(
  content: Buffer,
  sidecarOverride: Record<string, unknown> = {},
): string {
  const id = `test-upload-${++idCounter}`;
  writeFileSync(join(testTmpDir, id), content);
  const sidecar = {
    size: content.length,
    offset: content.length,
    metadata: { filename: "test.bin", filetype: "application/octet-stream" },
    ...sidecarOverride,
  };
  writeFileSync(join(testTmpDir, `${id}.json`), JSON.stringify(sidecar));
  return id;
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// v2 link mode
// ---------------------------------------------------------------------------

test(
  "finalize v2 link mode: renames blob, stores row (format=2, wrapped_key=null), returns {slug} with no key",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("fake encrypted content for link mode");
    const uploadId = makeFakeTusUpload(content);

    const req = makeRequest({ uploadId, format: 2 });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200, "should return 200");

    const json = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof json.slug === "string" && json.slug.length > 0, "response must include slug");
    assert.equal(json.key, undefined, "v2 link mode must NOT include key in response");

    // Blob must have been moved to UPLOADS_DIR (not left in TMP_DIR).
    const storedPath = join(testUploadsDir, uploadId);
    assert.ok(existsSync(storedPath), "blob must exist in UPLOADS_DIR");
    assert.equal(existsSync(join(testTmpDir, uploadId)), false, "blob must not remain in TMP_DIR");

    // DB row must record format=2 with null key material.
    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row, "DB row must exist");
    assert.equal(row.format, 2, "format must be 2");
    assert.equal(row.wrapped_key, null, "link mode: wrapped_key must be null");
    assert.equal(row.kdf_salt, null, "link mode: kdf_salt must be null");
    assert.equal(row.original_name, "", "server must not store the filename");
    assert.equal(row.mime, null, "server must not store the MIME type");
    assert.equal(row.password_hash, null, "server must not store a password hash");
    assert.equal(row.size, content.length, "stored size must match the blob size");
  },
);

// ---------------------------------------------------------------------------
// v2 password mode
// ---------------------------------------------------------------------------

test(
  "finalize v2 password mode: stores wrapped_key + kdf_salt as bytes from base64",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("fake encrypted content for password mode");
    const uploadId = makeFakeTusUpload(content);

    // Simulate a 48-byte wrapped key (32-byte K + 16-byte Poly1305 tag) and
    // a 16-byte Argon2id salt — realistic sizes per the spec (§4).
    const rawWrappedKey = Buffer.alloc(48, 0xab);
    const rawKdfSalt = Buffer.alloc(16, 0xcd);
    const wrappedKey = rawWrappedKey.toString("base64");
    const kdfSalt = rawKdfSalt.toString("base64");

    const req = makeRequest({ uploadId, format: 2, wrappedKey, kdfSalt });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200, "should return 200");

    const json = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof json.slug === "string", "response must include slug");
    assert.equal(json.key, undefined, "v2 password mode must NOT include key in response");

    // Blob stored.
    assert.ok(existsSync(join(testUploadsDir, uploadId)), "blob must be in UPLOADS_DIR");

    // DB row must store the BLOB columns byte-for-byte.
    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row, "DB row must exist");
    assert.equal(row.format, 2, "format must be 2");
    assert.ok(row.wrapped_key instanceof Buffer, "wrapped_key must be a Buffer");
    assert.ok(row.kdf_salt instanceof Buffer, "kdf_salt must be a Buffer");
    assert.deepEqual(row.wrapped_key, rawWrappedKey, "wrapped_key bytes must match");
    assert.deepEqual(row.kdf_salt, rawKdfSalt, "kdf_salt bytes must match");
  },
);

// ---------------------------------------------------------------------------
// v2 key verifier (download authorization)
// ---------------------------------------------------------------------------

// A well-formed verifier: 43 base64url chars (SHA-256, unpadded).
const GOOD_VERIFIER = "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU";

test(
  "finalize v2: stores a valid keyVerifier in the row",
  { skip: dbReason },
  async () => {
    const uploadId = makeFakeTusUpload(Buffer.from("blob with verifier"));

    const req = makeRequest({ uploadId, format: 2, keyVerifier: GOOD_VERIFIER });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row, "DB row must exist");
    assert.equal(row.key_verifier, GOOD_VERIFIER, "key_verifier must be stored verbatim");
  },
);

test(
  "finalize v2: keyVerifier is optional — absent stores NULL (legacy clients)",
  { skip: dbReason },
  async () => {
    const uploadId = makeFakeTusUpload(Buffer.from("blob without verifier"));

    const req = makeRequest({ uploadId, format: 2 });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row, "DB row must exist");
    assert.equal(row.key_verifier, null, "absent keyVerifier must store NULL");
  },
);

test(
  "finalize v2: invalid keyVerifier is 400 and the upload is NOT consumed",
  { skip: dbReason },
  async () => {
    const invalid = [
      GOOD_VERIFIER.slice(0, 42), // too short
      GOOD_VERIFIER + "A", // too long
      GOOD_VERIFIER.slice(0, 42) + "+", // standard-base64 charset
      GOOD_VERIFIER.slice(0, 42) + "=", // padding
      42, // not a string
    ];
    for (const keyVerifier of invalid) {
      const uploadId = makeFakeTusUpload(Buffer.from("blob, bad verifier"));

      const req = makeRequest({ uploadId, format: 2, keyVerifier });
      const res = await routeMod!.POST(req);
      assert.equal(res.status, 400, `must 400 for ${JSON.stringify(keyVerifier)}`);

      // The 400 must fire BEFORE any side effect: tmp blob still in place,
      // nothing published to UPLOADS_DIR.
      assert.ok(
        existsSync(join(testTmpDir, uploadId)),
        "tmp upload must survive a rejected finalize",
      );
      assert.equal(
        existsSync(join(testUploadsDir, uploadId)),
        false,
        "nothing may be published on a rejected finalize",
      );
    }
  },
);

// ---------------------------------------------------------------------------
// manage token ("delete early" credential)
// ---------------------------------------------------------------------------

test(
  "finalize: returns a raw manageToken and stores ONLY its hash",
  { skip: dbReason },
  async () => {
    const { hashManageToken, isValidManageToken } = await import(
      "../lib/manage-token"
    );
    const uploadId = makeFakeTusUpload(Buffer.from("blob with manage token"));

    const req = makeRequest({ uploadId, format: 2 });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    const manageToken = json.manageToken as string;
    assert.ok(
      typeof manageToken === "string" && isValidManageToken(manageToken),
      "response must include a well-formed raw manageToken",
    );

    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row, "DB row must exist");
    // The server stores ONLY the hash — never the raw token.
    assert.equal(
      row.manage_token_hash,
      hashManageToken(manageToken),
      "stored manage_token_hash must be SHA-256(token), base64url",
    );
    assert.notEqual(
      row.manage_token_hash,
      manageToken,
      "stored value must NOT be the raw token",
    );
  },
);

test(
  "finalize v1: also returns a manageToken and stores its hash",
  { skip: dbReason },
  async () => {
    const { isValidManageToken } = await import("../lib/manage-token");
    const uploadId = makeFakeTusUpload(Buffer.from("v1 blob with manage token"), {
      metadata: { filename: "v1.txt", filetype: "text/plain" },
    });

    const req = makeRequest({ uploadId });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    assert.ok(
      isValidManageToken(json.manageToken),
      "v1 response must also include a raw manageToken",
    );
    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row?.manage_token_hash, "v1 row must store a manage_token_hash");
  },
);

// ---------------------------------------------------------------------------
// v2 sidecar cleanup
// ---------------------------------------------------------------------------

test(
  "finalize v2: sidecar .json is removed after finalize",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("blob for sidecar test");
    const uploadId = makeFakeTusUpload(content);
    const sidecarPath = join(testTmpDir, `${uploadId}.json`);
    assert.ok(existsSync(sidecarPath), "sidecar must exist before finalize");

    const req = makeRequest({ uploadId, format: 2 });
    await routeMod!.POST(req);

    assert.equal(existsSync(sidecarPath), false, "sidecar must be removed after finalize");
  },
);

// ---------------------------------------------------------------------------
// v1 regression: legacy path still works
// ---------------------------------------------------------------------------

test(
  "finalize v1 (no format field): stores row with format=1, returns {slug} (no v2 fields)",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("plaintext v1 content");
    const uploadId = makeFakeTusUpload(content, {
      metadata: { filename: "readme.txt", filetype: "text/plain" },
    });

    // No `format` field → v1 path.
    const req = makeRequest({ uploadId, expiry: "1d" });
    const res = await routeMod!.POST(req);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof json.slug === "string", "must return slug");

    const row = db!.getFileBySlug(json.slug as string);
    assert.ok(row, "DB row must exist");
    assert.equal(row.format, 1, "v1 finalize must produce format=1");
    assert.equal(row.wrapped_key, null, "v1 row must have null wrapped_key");
    assert.equal(row.kdf_salt, null, "v1 row must have null kdf_salt");
    assert.equal(row.key_verifier, null, "v1 row must have null key_verifier");
    // v1 does store the filename (ENCRYPT_UPLOADS=false path → plaintext rename)
    assert.equal(row.original_name, "readme.txt");
  },
);
