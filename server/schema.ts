import type Database from "better-sqlite3";

// Schema creation + forward migrations for the files table, in one idempotent
// function so it can be unit-tested against a throwaway DB and reused by db.ts.
//
// Migrations are additive: new columns are added with ALTER TABLE only when
// missing, so an existing (pre-encryption) database keeps all its rows and they
// default to unencrypted (encrypted = 0).
export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id             TEXT PRIMARY KEY,
      slug           TEXT UNIQUE NOT NULL,
      original_name  TEXT NOT NULL,
      size           INTEGER NOT NULL,
      mime           TEXT,
      password_hash  TEXT,
      expires_at     INTEGER,
      created_at     INTEGER NOT NULL,
      download_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files (expires_at);
  `);

  const cols = new Set(
    (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE files ADD COLUMN ${ddl}`);
  };

  // Encryption metadata (v2). `encrypted` flags whether the stored blob is an
  // age file; `enc_mode` is "link" or "password"; `enc_key_wrapped` holds the
  // password-wrapped per-file key (password mode only — link mode keeps the key
  // in the share URL, never here). `size` keeps the *plaintext* size for the UI.
  addColumn("encrypted", "encrypted INTEGER NOT NULL DEFAULT 0");
  addColumn("enc_mode", "enc_mode TEXT");
  addColumn("enc_key_wrapped", "enc_key_wrapped TEXT");

  // Optional download limit (v2.7). NULL = unlimited; a positive integer caps the
  // number of downloads, after which the file + row are deleted. Existing rows
  // default to NULL (unlimited), preserving prior behaviour.
  addColumn("max_downloads", "max_downloads INTEGER");
}
