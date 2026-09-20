// The expiry options offered to the uploader. The values are the identifiers
// sent to the server; "never" has no expiry.
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
 * Resolves an expiry key to a unix-ms timestamp, or null for "never". Unknown
 * keys also give null, so a bad client value never shortens a share.
 */
export function expiryToTimestamp(value: string, now = Date.now()): number | null {
  const opt = BY_VALUE.get(value as ExpiryValue);
  if (!opt || opt.ms === 0) return null;
  return now + opt.ms;
}

/**
 * The expiry options this instance offers under the MAX_EXPIRY cap from
 * /api/config. An empty, unknown or "never" cap allows everything; a finite cap
 * drops "never" and every longer duration. EXPIRY_OPTIONS is sorted ascending,
 * so the cap is an index cut.
 */
export function allowedExpiryOptions(maxExpiry: string) {
  if (!maxExpiry || maxExpiry === "never" || !isValidExpiry(maxExpiry)) {
    return [...EXPIRY_OPTIONS];
  }
  const capIdx = EXPIRY_OPTIONS.findIndex((o) => o.value === maxExpiry);
  return EXPIRY_OPTIONS.slice(0, capIdx + 1);
}

/**
 * Clamps a wanted expiry to the cap. An invalid or too long value becomes the
 * longest allowed duration, the closest match to what the user wanted.
 */
export function clampExpiry(value: string, maxExpiry: string): ExpiryValue {
  const allowed = allowedExpiryOptions(maxExpiry);
  const hit = allowed.find((o) => o.value === value);
  if (hit) return hit.value;
  const finite = allowed.filter((o) => o.value !== "never");
  return (finite[finite.length - 1] ?? allowed[allowed.length - 1]).value;
}
