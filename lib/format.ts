// Pure formatting helpers — safe to use in both server and client components.

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Locale-independent description of a relative expiry. The UI turns this into
// text via i18next (keys relexp.never / relexp.expired / relexp.minutes|hours|
// days with a {{count}}), so the wording — and pluralization — lives in the
// locale files, not here.
export type ExpiryDescriptor =
  | { kind: "never" }
  | { kind: "expired" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number };

export function describeExpiry(
  expiresAt: number | null,
  now = Date.now(),
): ExpiryDescriptor {
  if (expiresAt === null) return { kind: "never" };
  const ms = expiresAt - now;
  if (ms <= 0) return { kind: "expired" };
  const mins = Math.round(ms / 60000);
  if (mins < 60) return { kind: "minutes", count: mins };
  const hours = Math.round(mins / 60);
  if (hours < 48) return { kind: "hours", count: hours };
  const days = Math.round(hours / 24);
  return { kind: "days", count: days };
}
