import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveBranding } from "./branding";

// DATA_DIR holds the uploaded files and CONFIG_DIR the SQLite metadata
// database. CONFIG_DIR defaults to DATA_DIR so single-volume installs keep
// working; the Unraid template sets it to put the database on its own volume.
export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const CONFIG_DIR = process.env.CONFIG_DIR ?? DATA_DIR;

export const UPLOADS_DIR = join(DATA_DIR, "uploads");
export const TMP_DIR = join(DATA_DIR, "tmp");
export const DB_PATH = join(CONFIG_DIR, "db.sqlite");

// Upload limit in bytes; 0 or unset means unlimited.
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE ?? 0);

// Applied when the uploader picks no expiry; lib/expiry.ts has the keys.
export const DEFAULT_EXPIRY = process.env.DEFAULT_EXPIRY ?? "7d";

// The public base URL for share links behind a reverse proxy. Without it the
// client uses window.location.origin.
export const BASE_URL = process.env.BASE_URL ?? "";

// Encrypts stored blobs with age unless ENCRYPT_UPLOADS=false. Each row's
// `encrypted` flag records how its blob was stored, so switching leaves
// existing files readable.
export const ENCRYPT_UPLOADS =
  (process.env.ENCRYPT_UPLOADS ?? "true").toLowerCase() !== "false";

// With a master key, password-less uploads get short links without a fragment:
// the per-file key is wrapped with it and stored. The key lives only in the
// container environment, not in /data, so a stolen data backup stays
// unreadable, and losing it makes those files unrecoverable.
export const MASTER_KEY = process.env.MASTER_KEY ?? "";
export const SERVER_KEY_MODE = MASTER_KEY.length > 0;

// Optional upload gate, see lib/upload-auth.ts. Downloads are never gated, and
// only the UPLOAD_PROTECTED flag reaches the client.
export const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD ?? "";
export const UPLOAD_PROTECTED = UPLOAD_PASSWORD.length > 0;

export const BRANDING = resolveBranding({
  APP_NAME: process.env.APP_NAME,
  APP_LOGO: process.env.APP_LOGO,
  ACCENT_COLOR: process.env.ACCENT_COLOR,
});

let dirsReady = false;

/** Creates the data directories once; safe to call repeatedly. */
export function ensureDataDirs(): void {
  if (dirsReady) return;
  for (const dir of [DATA_DIR, UPLOADS_DIR, TMP_DIR, CONFIG_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  dirsReady = true;
}
