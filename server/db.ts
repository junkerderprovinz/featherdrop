import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "../lib/config";
import { isExhausted } from "../lib/downloads";
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
  max_downloads: number | null; // null = unlimited; delete after this many
  encrypted: number; // 0 = plaintext blob, 1 = age-encrypted
  enc_mode: string | null; // "link" | "password" | null
  enc_key_wrapped: string | null; // password-wrapped per-file key (password mode)
}

export interface DownloadResult {
  allowed: boolean; // false = no such share, or its limit was already reached
  burned: boolean; // true = this was the final allowed download; row deleted
  recordId: string | null; // stored filename to remove from disk when burned
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
         created_at, max_downloads, encrypted, enc_mode, enc_key_wrapped)
       VALUES
        (@id, @slug, @original_name, @size, @mime, @password_hash, @expires_at,
         @created_at, @max_downloads, @encrypted, @enc_mode, @enc_key_wrapped)`,
    )
    .run(rec);
}

export function getFileBySlug(slug: string): FileRecord | undefined {
  return conn()
    .prepare(`SELECT * FROM files WHERE slug = ?`)
    .get(slug) as FileRecord | undefined;
}

/**
 * Atomically register one download against a share's limit. Bumps the counter
 * only while still under `max_downloads` (NULL = unlimited) and — when that was
 * the last allowed download — deletes the row in the SAME transaction, so
 * concurrent downloads of a limited share can never exceed the limit. The caller
 * removes the file from disk after streaming (see `recordId` / `burned`).
 */
export function registerDownload(slug: string): DownloadResult {
  const c = conn();
  const run = c.transaction((s: string): DownloadResult => {
    const upd = c
      .prepare(
        `UPDATE files SET download_count = download_count + 1
         WHERE slug = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
      )
      .run(s);
    if (upd.changes === 0) {
      return { allowed: false, burned: false, recordId: null };
    }
    const row = c
      .prepare(
        `SELECT id, download_count, max_downloads FROM files WHERE slug = ?`,
      )
      .get(s) as {
      id: string;
      download_count: number;
      max_downloads: number | null;
    };
    const burned = isExhausted(row.download_count, row.max_downloads);
    if (burned) c.prepare(`DELETE FROM files WHERE slug = ?`).run(s);
    return { allowed: true, burned, recordId: row.id };
  });
  return run(slug);
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
