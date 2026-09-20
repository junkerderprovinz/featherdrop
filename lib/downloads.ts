// Download limits. max_downloads is null for an unlimited share; otherwise the
// share is deleted after that many downloads. The server does the atomic count
// and delete in store.RegisterDownload.

const MAX_CAP = 10_000;

/** Remaining downloads, or null when unlimited. */
export function downloadsLeft(count: number, max: number | null): number | null {
  if (max === null) return null;
  return Math.max(0, max - count);
}

export function isExhausted(count: number, max: number | null): boolean {
  return max !== null && count >= max;
}

/**
 * Clamps an uploader-supplied limit to 1..MAX_CAP, or returns null, meaning
 * unlimited, for a missing, zero, negative or fractional value.
 */
export function parseMaxDownloads(
  input: number | null | undefined,
): number | null {
  if (input == null || !Number.isInteger(input) || input < 1) return null;
  return Math.min(input, MAX_CAP);
}
