// Remembered upload options (localStorage). The last-used expiry, download
// limit and metadata-strip choice are restored on the next visit, so a regular
// user sets them once instead of per upload. Deliberately NEVER the share
// password — secrets don't belong in localStorage.
//
// Storage is injectable and every access is guarded: privacy modes can throw on
// localStorage, and a corrupted value must never break the page — bad or
// missing data just falls back to the caller's defaults (null fields).

import { isValidExpiry } from "./expiry";

export const PREFS_STORAGE_KEY = "fd-upload-prefs";

export interface UploadPrefs {
  /** Last-used expiry key (validated), or null = no stored preference. */
  expiry: string | null;
  /** Last-used download limit; null = unlimited/off. */
  maxDownloads: number | null;
  /** Strip photo metadata (EXIF/GPS) before encrypting; null = default (on). */
  stripMetadata: boolean | null;
}

const EMPTY: UploadPrefs = { expiry: null, maxDownloads: null, stripMetadata: null };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadPrefs(store: StorageLike | null = storage()): UploadPrefs {
  if (!store) return { ...EMPTY };
  try {
    const raw = store.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<UploadPrefs>;
    const expiry =
      typeof parsed.expiry === "string" && isValidExpiry(parsed.expiry)
        ? parsed.expiry
        : null;
    const maxDownloads =
      typeof parsed.maxDownloads === "number" &&
      Number.isFinite(parsed.maxDownloads) &&
      parsed.maxDownloads >= 1
        ? Math.floor(parsed.maxDownloads)
        : null;
    const stripMetadata =
      typeof parsed.stripMetadata === "boolean" ? parsed.stripMetadata : null;
    return { expiry, maxDownloads, stripMetadata };
  } catch {
    return { ...EMPTY };
  }
}

export function savePrefs(
  prefs: UploadPrefs,
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota/privacy errors: remembering preferences is best-effort.
  }
}
