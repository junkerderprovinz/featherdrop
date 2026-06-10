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
  });
  return { slug, id };
}

function makeGetRequest(slug: string): NextRequest {
  return new NextRequest(`http://localhost/api/d/${slug}`);
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
