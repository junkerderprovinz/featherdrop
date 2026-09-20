// Picks the UI language in the browser: a stored cookie choice wins, then
// navigator.languages, then DEFAULT_LANGUAGE.
import { COOKIE, resolveLanguage } from "@/lib/i18n/detect";
import { SUPPORTED, DEFAULT_LANGUAGE } from "@/lib/i18n/locales";

// writeLanguageCookie sets it when the user switches language.
function readLanguageCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(COOKIE.length + 1));
  } catch {
    return match.slice(COOKIE.length + 1);
  }
}

export function detectClientLanguage(): string {
  const cookie = readLanguageCookie();
  const navLangs =
    typeof navigator !== "undefined"
      ? navigator.languages && navigator.languages.length > 0
        ? Array.from(navigator.languages)
        : navigator.language
          ? [navigator.language]
          : []
      : [];
  const candidates = [...(cookie ? [cookie] : []), ...navLangs];
  return resolveLanguage(candidates, SUPPORTED, DEFAULT_LANGUAGE);
}
