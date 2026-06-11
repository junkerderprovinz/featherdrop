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

  // Zero-knowledge v2 columns (Phase 7a).
  //
  // `format` distinguishes the two on-disk blob layouts:
  //   1 = legacy at-rest (age-encrypted, server holds the key on download)
  //   2 = zero-knowledge (browser-encrypted; server is a dumb byte store)
  // Existing rows default to 1 so the v1 read path continues to work unchanged.
  //
  // `wrapped_key` — password mode only: the per-file content key (K) wrapped
  // with the Argon2id-derived KEK. NULL for link-mode v2 uploads (K lives only
  // in the URL fragment) and for all v1 rows.
  //
  // `kdf_salt` — password mode only: the 16-byte Argon2id salt used to derive
  // the KEK. NULL when `wrapped_key` is NULL.
  addColumn("format", "format INTEGER NOT NULL DEFAULT 1");
  addColumn("wrapped_key", "wrapped_key BLOB");
  addColumn("kdf_salt", "kdf_salt BLOB");

  // `key_verifier` — format=2 download authorization: base64url(SHA-256(K)) of
  // the raw content key, computed client-side at upload. The download GET
  // requires a matching `x-fd-key-verifier` header before counting/burning a
  // download, so a leaked slug alone can't exhaust a limited share. One-way:
  // it never reveals K. NULL = pre-verifier v2 uploads (and all v1 rows) —
  // those keep downloading without proof, exactly as before.
  addColumn("key_verifier", "key_verifier TEXT");
}
