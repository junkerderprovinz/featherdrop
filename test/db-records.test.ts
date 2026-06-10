import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round-trip tests for createFileRecord + getFileBySlug covering both the
// legacy v1 (at-rest) and zero-knowledge v2 record formats.
// The DATA_DIR/CONFIG_DIR must be set BEFORE importing server/db (lib/config
// reads them at import time).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "fd-rec-"));
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
function uid(): string {
  return `rec-${++n}`;
}

// ---------------------------------------------------------------------------
// v1 legacy record round-trip
// ---------------------------------------------------------------------------

test("v1 record: createFileRecord + getFileBySlug round-trips all v1 fields", { skip: dbReason }, () => {
  const id = uid();
  const slug = `slug-v1-${n}`;
  const now = Date.now();

  db!.createFileRecord({
    id,
    slug,
    original_name: "document.pdf",
    size: 1234,
    mime: "application/pdf",
    password_hash: null,
    expires_at: now + 86_400_000,
    created_at: now,
    max_downloads: 5,
    encrypted: 1,
    enc_mode: "link",
    enc_key_wrapped: null,
    format: 1,
    wrapped_key: null,
    kdf_salt: null,
  });

  const row = db!.getFileBySlug(slug);
  assert.ok(row, "getFileBySlug must return the inserted row");
  assert.equal(row.id, id);
  assert.equal(row.slug, slug);
  assert.equal(row.original_name, "document.pdf");
  assert.equal(row.size, 1234);
  assert.equal(row.mime, "application/pdf");
  assert.equal(row.encrypted, 1);
  assert.equal(row.enc_mode, "link");
  assert.equal(row.enc_key_wrapped, null);
  assert.equal(row.format, 1, "v1 record must have format = 1");
  assert.equal(row.wrapped_key, null, "v1 record must have wrapped_key = null");
  assert.equal(row.kdf_salt, null, "v1 record must have kdf_salt = null");
});

// ---------------------------------------------------------------------------
// v2 zero-knowledge record round-trip (link mode — no key material on server)
// ---------------------------------------------------------------------------

test("v2 link-mode record: format = 2, wrapped_key/kdf_salt = null", { skip: dbReason }, () => {
  const id = uid();
  const slug = `slug-v2-link-${n}`;
  const now = Date.now();

  db!.createFileRecord({
    id,
    slug,
    original_name: "",   // server does not know the real filename
    size: 8192,
    mime: null,          // server does not know the MIME type
    password_hash: null,
    expires_at: null,
    created_at: now,
    max_downloads: null,
    encrypted: 0,        // v1 age-encryption flag is unused for v2 rows
    enc_mode: null,
    enc_key_wrapped: null,
    format: 2,
    wrapped_key: null,
    kdf_salt: null,
  });

  const row = db!.getFileBySlug(slug);
  assert.ok(row, "v2 link-mode row must be retrievable");
  assert.equal(row.format, 2, "format must be 2");
  assert.equal(row.wrapped_key, null, "link mode: wrapped_key must be null");
  assert.equal(row.kdf_salt, null, "link mode: kdf_salt must be null");
});

// ---------------------------------------------------------------------------
// v2 zero-knowledge record round-trip (password mode — BLOB columns populated)
// ---------------------------------------------------------------------------

test("v2 password-mode record: wrapped_key + kdf_salt survive the round-trip as Buffer", { skip: dbReason }, () => {
  const id = uid();
  const slug = `slug-v2-pw-${n}`;
  const now = Date.now();

  // Simulate the 48-byte wrapped key (32-byte K + 16-byte Poly1305 tag from
  // secretbox) and a 16-byte Argon2id salt — real sizes per the spec.
  const wrappedKey = Buffer.from(new Uint8Array(48).fill(0xab));
  const kdfSalt = Buffer.from(new Uint8Array(16).fill(0xcd));

  db!.createFileRecord({
    id,
    slug,
    original_name: "",
    size: 4096,
    mime: null,
    password_hash: null,
    expires_at: now + 3_600_000,
    created_at: now,
    max_downloads: 1,
    encrypted: 0,
    enc_mode: null,
    enc_key_wrapped: null,
    format: 2,
    wrapped_key: wrappedKey,
    kdf_salt: kdfSalt,
  });

  const row = db!.getFileBySlug(slug);
  assert.ok(row, "v2 password-mode row must be retrievable");
  assert.equal(row.format, 2, "format must be 2");

  // better-sqlite3 returns BLOBs as Buffer; compare byte-for-byte.
  assert.ok(row.wrapped_key instanceof Buffer, "wrapped_key must come back as Buffer");
  assert.ok(row.kdf_salt instanceof Buffer, "kdf_salt must come back as Buffer");
  assert.deepEqual(
    row.wrapped_key,
    wrappedKey,
    "wrapped_key bytes must round-trip identically",
  );
  assert.deepEqual(
    row.kdf_salt,
    kdfSalt,
    "kdf_salt bytes must round-trip identically",
  );
});
