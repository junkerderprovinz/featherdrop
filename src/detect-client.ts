// Client-side language detection for the Vite SPA.
//
// The Next app resolved the UI language on the SERVER (cookie -> Accept-Language
// -> fallback) in app/layout.tsx and passed it to I18nProvider. The static SPA
// has no server render, so we replicate that resolution in the browser using the
// SAME pure helper (resolveLanguage) and the SAME cookie name (COOKIE) from
// lib/i18n/detect — an explicit cookie choice wins, then the browser's
// navigator.languages, then DEFAULT_LANGUAGE.
import { COOKIE, resolveLanguage } from "@/lib/i18n/detect";
import { SUPPORTED, DEFAULT_LANGUAGE } from "@/lib/i18n/locales";

// Read the persisted fd_lang cookie (set by writeLanguageCookie on a switch).
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

// Resolve the UI language from the cookie then the browser's preferred locales,
// mirroring the server's pickLanguage(cookie, Accept-Language, …) ordering.
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
