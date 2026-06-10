import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the atomic download counter / burn-after-download logic of
// server/db.ts against a throwaway database. Point DATA_DIR/CONFIG_DIR at a
// fresh temp dir BEFORE importing the module (lib/config reads them at import
// time), then drive the real createFileRecord + registerDownload code paths.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "fd-dl-"));
process.env.CONFIG_DIR = process.env.DATA_DIR;

// better-sqlite3 is a native addon; on a dev box without a compiler it may not
// be built. Skip these (the CI test job builds it) rather than failing locally.
let dbReason: string | boolean = false;
try {
  const Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  dbReason = "better-sqlite3 native addon not built";
}

// Only load the DB module when the native addon is available — importing it
// otherwise throws at module level and would fail the whole file.
type Db = typeof import("../server/db");
let db: Db | undefined;
if (!dbReason) {
  db = await import("../server/db");
  db.initDb();
}

let n = 0;
// Insert a share with the given limit and return its slug. Each call uses a
// fresh slug/id so the tests don't interfere with one another.
function makeShare(maxDownloads: number | null): string {
  const slug = `slug-${++n}`;
  db!.createFileRecord({
    id: `id-${n}`,
    slug,
    original_name: "file.txt",
    size: 10,
    mime: "text/plain",
    password_hash: null,
    expires_at: null,
    created_at: Date.now(),
    max_downloads: maxDownloads,
    encrypted: 0,
    enc_mode: null,
    enc_key_wrapped: null,
    format: 1,
    wrapped_key: null,
    kdf_salt: null,
  });
  return slug;
}

test("unlimited share: every download is allowed and never burns", { skip: dbReason }, () => {
  const slug = makeShare(null);
  for (let i = 0; i < 3; i++) {
    const r = db!.registerDownload(slug);
    assert.equal(r.allowed, true, `download ${i} should be allowed`);
    assert.equal(r.burned, false, `download ${i} should not burn`);
  }
  // Row survives all of them.
  assert.ok(db!.getFileBySlug(slug), "unlimited share should still exist");
});

test("limit 1: the first download burns and removes the row", { skip: dbReason }, () => {
  const slug = makeShare(1);
  const r = db!.registerDownload(slug);
  assert.equal(r.allowed, true);
  assert.equal(r.burned, true, "single-download share should burn at once");
  assert.equal(db!.getFileBySlug(slug), undefined, "row should be deleted");
});

test("a download after burn is rejected", { skip: dbReason }, () => {
  const slug = makeShare(1);
  db!.registerDownload(slug); // burns
  const r = db!.registerDownload(slug); // row is gone
  assert.equal(r.allowed, false, "no download allowed after burn");
  assert.equal(r.burned, false);
  assert.equal(r.recordId, null);
});

test("limit 2: first download allowed without burning, second burns", { skip: dbReason }, () => {
  const slug = makeShare(2);
  const first = db!.registerDownload(slug);
  assert.equal(first.allowed, true);
  assert.equal(first.burned, false, "first of two should not burn");
  assert.ok(db!.getFileBySlug(slug), "row survives the first download");

  const second = db!.registerDownload(slug);
  assert.equal(second.allowed, true);
  assert.equal(second.burned, true, "second of two should burn");
  assert.equal(db!.getFileBySlug(slug), undefined, "row gone after the limit");
});
