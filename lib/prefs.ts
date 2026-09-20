// The last-used expiry, download limit and metadata choice are kept in
// localStorage so a regular user sets them once. The share password is never
// stored there. Privacy modes can throw on localStorage access, and bad or
// missing data falls back to the caller's defaults.

import { isValidExpiry } from "./expiry";

export const PREFS_STORAGE_KEY = "fd-upload-prefs";

export interface UploadPrefs {
  /** Last-used expiry key, or null without a stored preference. */
  expiry: string | null;
  /** Last-used download limit; null for unlimited. */
  maxDownloads: number | null;
  /** Strip photo metadata before encrypting; null for the default, on. */
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
    // Quota and privacy errors; remembering preferences is best effort.
  }
}
