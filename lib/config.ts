import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Single source of truth for runtime configuration. All paths live under
// DATA_DIR so the whole state (files + metadata) is one mountable volume.
export const DATA_DIR = process.env.DATA_DIR ?? "./data";

export const UPLOADS_DIR = join(DATA_DIR, "uploads"); // finalized shared files
export const TMP_DIR = join(DATA_DIR, "tmp"); // in-progress tus uploads
export const DB_PATH = join(DATA_DIR, "db.sqlite"); // metadata

// Max upload size in bytes. 0 / unset = unlimited (limited only by disk).
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE ?? 0);

// Default expiry applied when the uploader does not pick one. See lib/expiry.ts
// for the allowed keys. "7d" is a sensible WeTransfer-like default.
export const DEFAULT_EXPIRY = process.env.DEFAULT_EXPIRY ?? "7d";

// Public base URL used to build share links (needed behind a reverse proxy).
// When unset the client falls back to window.location.origin.
export const BASE_URL = process.env.BASE_URL ?? "";

let dirsReady = false;

/** Create the data sub-directories once; safe to call repeatedly. */
export function ensureDataDirs(): void {
  if (dirsReady) return;
  for (const dir of [DATA_DIR, UPLOADS_DIR, TMP_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  dirsReady = true;
}
