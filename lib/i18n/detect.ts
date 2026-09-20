export const COOKIE = "fd_lang";

/**
 * Returns the first supported language among the candidates, most preferred
 * first. A region variant falls back to its base (de-AT to de), and fallback
 * is used when nothing matches.
 */
export function resolveLanguage(
  candidates: readonly string[],
  supported: readonly string[],
  fallback: string,
): string {
  const supportedSet = new Set(supported.map((s) => s.toLowerCase()));

  for (const raw of candidates) {
    const tag = raw?.trim().toLowerCase();
    if (!tag) continue;
    if (supportedSet.has(tag)) return tag;
    const base = tag.split("-")[0];
    if (base && supportedSet.has(base)) return base;
  }

  return fallback;
}

/**
 * Parses an Accept-Language header into locale tags sorted by q-value, most
 * preferred first. Equal q-values keep their order, and the wildcard and
 * malformed entries are dropped.
 */
export function parseAcceptLanguage(
  header: string | null | undefined,
): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const qRaw = qParam ? Number(qParam.trim().slice(2)) : 1;
      const q = Number.isFinite(qRaw) ? qRaw : 1;
      return { tag: tag.trim(), q, index };
    })
    .filter((e) => e.tag && e.tag !== "*")
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}

/**
 * Picks a language from a cookie and an Accept-Language header: the cookie
 * wins, then the header, then fallback.
 */
export function pickLanguage(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
  supported: readonly string[],
  fallback: string,
): string {
  const candidates = [
    ...(cookie ? [cookie] : []),
    ...parseAcceptLanguage(acceptLanguage),
  ];
  return resolveLanguage(candidates, supported, fallback);
}

/** Keeps the chosen language for a year. */
export function writeLanguageCookie(code: string): void {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${COOKIE}=${encodeURIComponent(code)}; path=/; max-age=${maxAge}; samesite=lax`;
}
