// Allowed expiry options offered to the uploader. Keys are stable identifiers
// sent from the client; values are durations in milliseconds. "never" = no
// expiry (the file lives until manually removed / disk pressure).
export const EXPIRY_OPTIONS = [
  { value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { value: "6h", label: "6 hours", ms: 6 * 60 * 60 * 1000 },
  { value: "1d", label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "never", label: "Never", ms: 0 },
] as const;

export type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]["value"];

const BY_VALUE = new Map(EXPIRY_OPTIONS.map((o) => [o.value, o]));

export function isValidExpiry(value: string): value is ExpiryValue {
  return BY_VALUE.has(value as ExpiryValue);
}

/**
 * Resolve an expiry option key to an absolute unix-ms timestamp.
 * Returns null for "never" (stored as NULL = no expiry). Unknown keys fall
 * back to null so a bad client value never silently shortens a share.
 */
export function expiryToTimestamp(value: string, now = Date.now()): number | null {
  const opt = BY_VALUE.get(value as ExpiryValue);
  if (!opt || opt.ms === 0) return null;
  return now + opt.ms;
}
