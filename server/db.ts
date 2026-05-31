import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "../lib/config";

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
}

let db: Database.Database | null = null;

/** Open the SQLite file and create the schema if needed. Idempotent. */
export function initDb(): Database.Database {
  if (db) return db;
  ensureDataDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
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
  return db;
}

function conn(): Database.Database {
  return db ?? initDb();
}

export function createFileRecord(rec: Omit<FileRecord, "download_count">): void {
  conn()
    .prepare(
      `INSERT INTO files
        (id, slug, original_name, size, mime, password_hash, expires_at, created_at)
       VALUES
        (@id, @slug, @original_name, @size, @mime, @password_hash, @expires_at, @created_at)`,
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
