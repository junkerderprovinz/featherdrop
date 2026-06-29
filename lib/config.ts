import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveBranding } from "./branding";

// Single source of truth for runtime configuration.
// DATA_DIR holds the bulk uploaded files; CONFIG_DIR holds the small SQLite
// metadata database. CONFIG_DIR defaults to DATA_DIR, so existing single-volume
// installs keep working unchanged — set it (the Unraid template does) to put the
// database on a separate, e.g. faster, volume.
export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const CONFIG_DIR = process.env.CONFIG_DIR ?? DATA_DIR;

export const UPLOADS_DIR = join(DATA_DIR, "uploads"); // finalized shared files
export const TMP_DIR = join(DATA_DIR, "tmp"); // in-progress tus uploads
export const DB_PATH = join(CONFIG_DIR, "db.sqlite"); // metadata

// Max upload size in bytes. 0 / unset = unlimited (limited only by disk).
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE ?? 0);

// Default expiry applied when the uploader does not pick one. See lib/expiry.ts
// for the allowed keys. "7d" is a sensible WeTransfer-like default.
export const DEFAULT_EXPIRY = process.env.DEFAULT_EXPIRY ?? "7d";

// Public base URL used to build share links (needed behind a reverse proxy).
// Resolved on the server and passed to the client via ServerConfigProvider
// (a plain runtime env var is not visible to client components otherwise).
// When unset the client falls back to window.location.origin.
export const BASE_URL = process.env.BASE_URL ?? "";

// Encrypt uploaded files at rest (age). On by default; set ENCRYPT_UPLOADS=false
// to store plaintext blobs (e.g. for debugging). Existing files are unaffected
// either way — the per-row `encrypted` flag records how each blob was stored.
export const ENCRYPT_UPLOADS =
  (process.env.ENCRYPT_UPLOADS ?? "true").toLowerCase() !== "false";

// Server master key. When set, password-less uploads get short links (…/d/slug
// with no #fragment): the per-file key is wrapped with this master key and
// stored, instead of riding in the URL. The key lives only in the container
// environment, not in the /data volume, so a stolen data backup stays unreadable.
// Losing it makes password-less files unrecoverable. Unset = fall back to the
// #fragment link mode.
export const MASTER_KEY = process.env.MASTER_KEY ?? "";
export const SERVER_KEY_MODE = MASTER_KEY.length > 0;

// Optional upload gate. When set, CREATING a share requires this secret: the
// client sends it in the `x-fd-upload-token` header and the server compares it
// constant-time on both write paths (tus + /api/finalize). Empty/unset = uploads
// are open to everyone (the default, unchanged). Downloading a share link is
// NEVER affected — only uploads are gated. The secret stays in the container
// environment: only the boolean `UPLOAD_PROTECTED` is ever exposed to the client.
export const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD ?? "";
export const UPLOAD_PROTECTED = UPLOAD_PASSWORD.length > 0;

// Custom branding (app name, logo, accent colour) for self-hosters. Resolved
// once on the server from the environment; passed to the client via props.
export const BRANDING = resolveBranding({
  APP_NAME: process.env.APP_NAME,
  APP_LOGO: process.env.APP_LOGO,
  ACCENT_COLOR: process.env.ACCENT_COLOR,
});

let dirsReady = false;

/** Create the data sub-directories once; safe to call repeatedly. */
export function ensureDataDirs(): void {
  if (dirsReady) return;
  for (const dir of [DATA_DIR, UPLOADS_DIR, TMP_DIR, CONFIG_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  dirsReady = true;
}
