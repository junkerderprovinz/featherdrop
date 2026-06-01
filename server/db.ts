import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "../lib/config";
import { applySchema } from "./schema";

export interface FileRecord {
  id: string; // stored filename under UPLOADS_DIR
  slug: string; // public share identifier
  original_name: string;
  size: number;
  mime: string | null;
  password_hash: string | null;
  expires_at: number | null; // unix ms, null = never
  created_at: number; // unix ms
  download_count: number;
  encrypted: number; // 0 = plaintext blob, 1 = age-encrypted
  enc_mode: string | null; // "link" | "password" | null
  enc_key_wrapped: string | null; // password-wrapped per-file key (password mode)
}

let db: Database.Database | null = null;

/** Open the SQLite file and create/migrate the schema if needed. Idempotent. */
export function initDb(): Database.Database {
  if (db) return db;
  ensureDataDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  applySchema(db);
  return db;
}

function conn(): Database.Database {
  return db ?? initDb();
}

export function createFileRecord(rec: Omit<FileRecord, "download_count">): void {
  conn()
    .prepare(
      `INSERT INTO files
        (id, slug, original_name, size, mime, password_hash, expires_at,
         created_at, encrypted, enc_mode, enc_key_wrapped)
       VALUES
        (@id, @slug, @original_name, @size, @mime, @password_hash, @expires_at,
         @created_at, @encrypted, @enc_mode, @enc_key_wrapped)`,
    )
    .run(rec);
}

export function getFileBySlug(slug: string): FileRecord | undefined {
  return conn()
    .prepare(`SELECT * FROM files WHERE slug = ?`)
    .get(slug) as FileRecord | undefined;
}

export function incrementDownloadCount(slug: string): void {
  conn()
    .prepare(`UPDATE files SET download_count = download_count + 1 WHERE slug = ?`)
    .run(slug);
}

/** Rows whose expiry has passed (expires_at not null and <= now). */
export function listExpired(now = Date.now()): FileRecord[] {
  return conn()
    .prepare(
      `SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(now) as FileRecord[];
}

export function deleteFileRecord(id: string): void {
  conn().prepare(`DELETE FROM files WHERE id = ?`).run(id);
}
