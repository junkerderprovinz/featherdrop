// Optional download limit / burn-after-download. `max_downloads` is null for an
// unlimited share; a positive integer caps how many times it can be downloaded,
// after which the file and its DB row are deleted. The atomic count++/delete
// lives in server/db.ts `registerDownload`; this module holds the pure helpers.

const MAX_CAP = 10_000;

/** Remaining downloads, or null when unlimited. */
export function downloadsLeft(count: number, max: number | null): number | null {
  if (max === null) return null;
  return Math.max(0, max - count);
}

/** Whether a finite-limit share has used up all its downloads. */
export function isExhausted(count: number, max: number | null): boolean {
  return max !== null && count >= max;
}

/**
 * Normalise an uploader-supplied limit to a positive integer (1..MAX_CAP) or
 * null (= unlimited) for anything missing, zero, negative, or non-integer.
 */
export function parseMaxDownloads(
  input: number | null | undefined,
): number | null {
  if (input == null || !Number.isInteger(input) || input < 1) return null;
  return Math.min(input, MAX_CAP);
}
