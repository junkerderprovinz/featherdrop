// The page's language: a choice stored in the fd_lang cookie wins, then the
// browser's languages, then English. Every text reads the language through
// this module, so a switch redraws the page.
import { reactive } from "vue";
import { COOKIE, resolveLanguage, writeLanguageCookie } from "@/lib/i18n/detect";
import { DEFAULT_LANGUAGE, isRtl, LANGUAGES, localeOf, SUPPORTED } from "@/lib/i18n/languages";
import { plural as pluralIn, translate, type Params } from "@/lib/i18n/translate";

function storedLanguage(): string | null {
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

export function browserLanguage(): string {
  const wanted = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
  return resolveLanguage(wanted, SUPPORTED, DEFAULT_LANGUAGE);
}

const state = reactive({ lang: resolveLanguage([storedLanguage() ?? "", browserLanguage()], SUPPORTED, DEFAULT_LANGUAGE) });

function show(code: string) {
  document.documentElement.lang = code;
  document.documentElement.dir = isRtl(code) ? "rtl" : "ltr";
}
show(state.lang);

export function setLanguage(code: string) {
  state.lang = code;
  writeLanguageCookie(code);
  show(code);
}

export const language = () => state.lang;
export const locale = () => localeOf(state.lang);
export const languages = () => LANGUAGES;

export const t = (key: string, params?: Params) => translate(state.lang, key, params);
export const plural = (n: number, key: string, params?: Params) => pluralIn(state.lang, n, key, params);
export const num = (n: number, options?: Intl.NumberFormatOptions) => n.toLocaleString(locale(), options);
