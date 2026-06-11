import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point DATA_DIR/CONFIG_DIR at throw-away temp dirs BEFORE any module that
// reads lib/config (config reads them at import time via top-level `process.env`).
const testDataDir = mkdtempSync(join(tmpdir(), "fd-dl-rt-"));
const testUploadsDir = join(testDataDir, "uploads");
const testTmpDir = join(testDataDir, "tmp");
mkdirSync(testUploadsDir, { recursive: true });
mkdirSync(testTmpDir, { recursive: true });

process.env.DATA_DIR = testDataDir;
process.env.CONFIG_DIR = testDataDir;
// Disable server-side encryption: v1 records in these tests are plaintext so
// we can exercise the download logic without the age crypto machinery.
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
type RouteModule = typeof import("../app/api/d/[slug]/route");
let routeMod: RouteModule | undefined;
type DbModule = typeof import("../server/db");
let db: DbModule | undefined;

if (!dbReason) {
  routeMod = await import("../app/api/d/[slug]/route");
  db = await import("../server/db");
  db.initDb();
}

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function uid(): string {
  return `dl-${++counter}`;
}

/** Write a blob into UPLOADS_DIR and seed a DB record for it. */
function seedV2Record(
  content: Buffer,
  opts: {
    maxDownloads?: number | null;
    expiresAt?: number | null;
    wrappedKey?: Buffer | null;
    kdfSalt?: Buffer | null;
    keyVerifier?: string | null;
  } = {},
): { slug: string; id: string } {
  const id = uid();
  const slug = `slug-${id}`;
  writeFileSync(join(testUploadsDir, id), content);
  db!.createFileRecord({
    id,
    slug,
    original_name: "",
    size: content.length,
    mime: null,
    password_hash: null,
    expires_at: opts.expiresAt ?? null,
    created_at: Date.now(),
    max_downloads: opts.maxDownloads ?? null,
    encrypted: 0,
    enc_mode: null,
    enc_key_wrapped: null,
    format: 2,
    wrapped_key: opts.wrappedKey ?? null,
    kdf_salt: opts.kdfSalt ?? null,
    key_verifier: opts.keyVerifier ?? null,
  });
  return { slug, id };
}

/** Seed a v1 plaintext record (no encryption). */
function seedV1Record(content: Buffer): { slug: string; id: string } {
  const id = uid();
  const slug = `slug-${id}`;
  writeFileSync(join(testUploadsDir, id), content);
  db!.createFileRecord({
    id,
    slug,
    original_name: "legacy.txt",
    size: content.length,
    mime: "text/plain",
    password_hash: null,
    expires_at: null,
    created_at: Date.now(),
    max_downloads: null,
    encrypted: 0,
    enc_mode: null,
    enc_key_wrapped: null,
    format: 1,
    wrapped_key: null,
    kdf_salt: null,
    key_verifier: null,
  });
  return { slug, id };
}

function makeGetRequest(slug: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost/api/d/${slug}`, { headers });
}

// ---------------------------------------------------------------------------
// v2: basic download — bytes served verbatim
// ---------------------------------------------------------------------------

test(
  "download v2: GET returns 200, Content-Type octet-stream, verbatim blob bytes",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("encrypted blob bytes that must be served verbatim");
    const { slug } = seedV2Record(content);

    const req = makeGetRequest(slug);
    const res = await routeMod!.GET(req, { params: { slug } });
    assert.equal(res.status, 200, "should return 200");
    assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(
      res.headers.get("Content-Disposition"),
      'attachment; filename="download"',
    );
    assert.equal(
      res.headers.get("Content-Length"),
      String(content.length),
      "Content-Length must equal blob size",
    );

    // Body bytes must be byte-for-byte identical to the stored blob.
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, content, "response body must be the raw stored bytes");
  },
);

// ---------------------------------------------------------------------------
// v2: download count is incremented
// ---------------------------------------------------------------------------

test(
  "download v2: download is counted (registerDownload called)",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("count me");
    const { slug } = seedV2Record(content, { maxDownloads: null });

    const req = makeGetRequest(slug);
    await routeMod!.GET(req, { params: { slug } });

    // Row must still exist (unlimited) but download_count should have increased.
    const row = db!.getFileBySlug(slug);
    assert.ok(row, "row must still exist for unlimited share");
    assert.equal(row.download_count, 1, "download_count must be 1 after one GET");
  },
);

// ---------------------------------------------------------------------------
// v2: burn-after-download (max_downloads = 1)
// ---------------------------------------------------------------------------

test(
  "download v2 burn: first GET 200, second GET 404, blob removed from disk",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("burn after download content");
    const { slug, id } = seedV2Record(content, { maxDownloads: 1 });
    const blobPath = join(testUploadsDir, id);

    // First download: must succeed.
    const res1 = await routeMod!.GET(makeGetRequest(slug), { params: { slug } });
    assert.equal(res1.status, 200, "first download must be 200");
    // Drain body so the burn-on-close hook can fire.
    await res1.arrayBuffer();

    // The row is deleted synchronously by registerDownload (burned=true).
    // The blob is removed asynchronously on stream close — give the event loop
    // a chance to run the close handler.
    await new Promise((r) => setTimeout(r, 50));

    // Second download: must be 404 (row is gone).
    const res2 = await routeMod!.GET(makeGetRequest(slug), { params: { slug } });
    assert.equal(res2.status, 404, "second download must be 404");

    // Blob must have been removed from disk.
    assert.equal(existsSync(blobPath), false, "blob must be removed after burn");
  },
);

// ---------------------------------------------------------------------------
// v2: not found
// ---------------------------------------------------------------------------

test(
  "download v2: unknown slug returns 404",
  { skip: dbReason },
  async () => {
    const res = await routeMod!.GET(makeGetRequest("nope-nope-nope"), {
      params: { slug: "nope-nope-nope" },
    });
    assert.equal(res.status, 404);
  },
);

// ---------------------------------------------------------------------------
// v2 with password mode fields: wrapped_key served but response is still octet-stream
// ---------------------------------------------------------------------------

test(
  "download v2 password mode: serves raw blob regardless of wrapped_key presence",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("password-protected encrypted blob");
    const { slug } = seedV2Record(content, {
      wrappedKey: Buffer.alloc(48, 0xab),
      kdfSalt: Buffer.alloc(16, 0xcd),
    });

    const res = await routeMod!.GET(makeGetRequest(slug), { params: { slug } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, content);
  },
);

// ---------------------------------------------------------------------------
// v2 key verifier: a stored verifier gates counting + serving
// ---------------------------------------------------------------------------

// Two well-formed 43-char base64url verifiers (the route compares strings; it
// never recomputes a hash, so any base64url(SHA-256) shaped value works here).
const VERIFIER = "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU";
const WRONG_VERIFIER = "Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0";
const HEADER = "x-fd-key-verifier";

test(
  "download v2 verifier: missing header is 401 and nothing is counted or burned",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("protected blob");
    const { slug, id } = seedV2Record(content, {
      maxDownloads: 1,
      keyVerifier: VERIFIER,
    });

    const res = await routeMod!.GET(makeGetRequest(slug), { params: { slug } });
    assert.equal(res.status, 401, "no header must be 401");

    // The share must be completely untouched: count 0, row present, blob present.
    const row = db!.getFileBySlug(slug);
    assert.ok(row, "row must survive an unauthorized GET");
    assert.equal(row.download_count, 0, "nothing may be counted");
    assert.ok(existsSync(join(testUploadsDir, id)), "blob must survive");
  },
);

test(
  "download v2 verifier: wrong header is 401 and nothing is counted",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("protected blob 2");
    const { slug } = seedV2Record(content, {
      maxDownloads: 1,
      keyVerifier: VERIFIER,
    });

    const res = await routeMod!.GET(
      makeGetRequest(slug, { [HEADER]: WRONG_VERIFIER }),
      { params: { slug } },
    );
    assert.equal(res.status, 401, "wrong verifier must be 401");

    const row = db!.getFileBySlug(slug);
    assert.ok(row, "row must survive");
    assert.equal(row.download_count, 0, "nothing may be counted");
  },
);

test(
  "download v2 verifier: wrong-LENGTH header is 401 (no throw, no count)",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("protected blob 3");
    const { slug } = seedV2Record(content, { keyVerifier: VERIFIER });

    const res = await routeMod!.GET(
      makeGetRequest(slug, { [HEADER]: "short" }),
      { params: { slug } },
    );
    assert.equal(res.status, 401);

    const row = db!.getFileBySlug(slug);
    assert.ok(row);
    assert.equal(row.download_count, 0);
  },
);

test(
  "download v2 verifier: correct header is 200, counted, bytes verbatim",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("protected blob served with proof");
    const { slug } = seedV2Record(content, { keyVerifier: VERIFIER });

    const res = await routeMod!.GET(
      makeGetRequest(slug, { [HEADER]: VERIFIER }),
      { params: { slug } },
    );
    assert.equal(res.status, 200, "correct verifier must be 200");
    assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, content, "bytes must be served verbatim");

    const row = db!.getFileBySlug(slug);
    assert.ok(row, "unlimited share row must remain");
    assert.equal(row.download_count, 1, "download must be counted exactly once");
  },
);

test(
  "download v2 verifier: burn-after-download still works with the header",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("burnable protected blob");
    const { slug, id } = seedV2Record(content, {
      maxDownloads: 1,
      keyVerifier: VERIFIER,
    });
    const blobPath = join(testUploadsDir, id);

    const res1 = await routeMod!.GET(
      makeGetRequest(slug, { [HEADER]: VERIFIER }),
      { params: { slug } },
    );
    assert.equal(res1.status, 200);
    await res1.arrayBuffer();
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await routeMod!.GET(
      makeGetRequest(slug, { [HEADER]: VERIFIER }),
      { params: { slug } },
    );
    assert.equal(res2.status, 404, "burned share must be gone");
    assert.equal(existsSync(blobPath), false, "blob must be removed after burn");
  },
);

test(
  "download v2 backward compat: NULL key_verifier serves without any header",
  { skip: dbReason },
  async () => {
    // A pre-verifier v2 upload (key_verifier NULL) must download exactly as
    // before — no header required, download counted.
    const content = Buffer.from("legacy v2 share without verifier");
    const { slug } = seedV2Record(content, { keyVerifier: null });

    const res = await routeMod!.GET(makeGetRequest(slug), { params: { slug } });
    assert.equal(res.status, 200, "legacy v2 share must stay downloadable");
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, content);

    const row = db!.getFileBySlug(slug);
    assert.ok(row);
    assert.equal(row.download_count, 1, "legacy share download is still counted");
  },
);

// ---------------------------------------------------------------------------
// v1 regression: legacy plaintext record still downloads via old path
// ---------------------------------------------------------------------------

test(
  "download v1 regression: plaintext legacy record returns 200 with correct Content-Type",
  { skip: dbReason },
  async () => {
    const content = Buffer.from("legacy plaintext content");
    const { slug } = seedV1Record(content);

    const res = await routeMod!.GET(makeGetRequest(slug), { params: { slug } });
    assert.equal(res.status, 200, "v1 record must still return 200");
    // v1 plaintext path sets Content-Type from the stored MIME.
    assert.equal(res.headers.get("Content-Type"), "text/plain");
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, content, "v1 body must equal the stored plaintext");
  },
);
