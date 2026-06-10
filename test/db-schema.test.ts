import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reproduce the schema-creation + migration logic of server/db.ts against a
// throwaway database file, including the "old DB with no enc_ columns" case, so
// we prove the ALTERs are additive and idempotent (existing rows survive).
import { applySchema } from "../server/schema";

// better-sqlite3 is a native addon; on a dev box without a compiler it may not
// be built. Skip these (the CI test job builds it) rather than failing locally.
let Database: typeof import("better-sqlite3");
let dbReason: string | boolean = false;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  dbReason = "better-sqlite3 native addon not built";
}

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-db-"));
  return join(dir, "db.sqlite");
}

test("applySchema creates the files table with the encryption columns", { skip: dbReason }, () => {
  const db = new Database(freshDbPath());
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  for (const c of ["encrypted", "enc_key_wrapped", "enc_mode"]) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  db.close();
});

test("applySchema is idempotent — running twice does not throw", { skip: dbReason }, () => {
  const db = new Database(freshDbPath());
  applySchema(db);
  assert.doesNotThrow(() => applySchema(db));
  db.close();
});

test("migrates a legacy DB that predates the encryption columns", { skip: dbReason }, () => {
  const path = freshDbPath();
  const legacy = new Database(path);
  // The exact pre-encryption schema.
  legacy.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, original_name TEXT NOT NULL,
      size INTEGER NOT NULL, mime TEXT, password_hash TEXT, expires_at INTEGER,
      created_at INTEGER NOT NULL, download_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacy
    .prepare(
      `INSERT INTO files (id, slug, original_name, size, created_at) VALUES (?,?,?,?,?)`,
    )
    .run("old1", "slugold", "legacy.txt", 10, Date.now());
  legacy.close();

  // Re-open and migrate.
  const db = new Database(path);
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("encrypted"), "migration did not add enc columns");

  const row = db.prepare("SELECT * FROM files WHERE id = ?").get("old1") as {
    original_name: string;
    encrypted: number;
  };
  assert.equal(row.original_name, "legacy.txt", "legacy row was lost");
  assert.equal(row.encrypted, 0, "legacy row should default to unencrypted");
  db.close();
});

// Phase 7a: zero-knowledge v2 columns ----------------------------------------

test("applySchema adds the v2 ZK columns (format, wrapped_key, kdf_salt)", { skip: dbReason }, () => {
  const db = new Database(freshDbPath());
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  for (const c of ["format", "wrapped_key", "kdf_salt"]) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  db.close();
});

test("migrated legacy rows get format = 1 (legacy at-rest)", { skip: dbReason }, () => {
  const path = freshDbPath();
  // Build a pre-v2 DB (only the v1 enc columns, no format column).
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, original_name TEXT NOT NULL,
      size INTEGER NOT NULL, mime TEXT, password_hash TEXT, expires_at INTEGER,
      created_at INTEGER NOT NULL, download_count INTEGER NOT NULL DEFAULT 0,
      encrypted INTEGER NOT NULL DEFAULT 0,
      enc_mode TEXT,
      enc_key_wrapped TEXT,
      max_downloads INTEGER
    );
  `);
  legacy
    .prepare(
      `INSERT INTO files (id, slug, original_name, size, created_at, encrypted)
       VALUES (?,?,?,?,?,?)`,
    )
    .run("v1row", "slugv1", "old.txt", 42, Date.now(), 1);
  legacy.close();

  // Migrate forward.
  const db = new Database(path);
  applySchema(db);

  const row = db.prepare("SELECT format FROM files WHERE id = ?").get("v1row") as {
    format: number;
  };
  assert.equal(row.format, 1, "pre-existing rows must default to format = 1");
  db.close();
});

test("applySchema with v2 columns is idempotent (running twice does not throw)", { skip: dbReason }, () => {
  const db = new Database(freshDbPath());
  applySchema(db);
  assert.doesNotThrow(() => applySchema(db), "second applySchema must be a no-op");
  db.close();
});
