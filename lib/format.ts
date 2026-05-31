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

/** Human relative expiry, e.g. "in 7 days" or "Never". */
export function formatExpiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "Never expires";
  const ms = expiresAt - now;
  if (ms <= 0) return "Expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Expires in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Expires in ${hours} h`;
  const days = Math.round(hours / 24);
  return `Expires in ${days} days`;
}
