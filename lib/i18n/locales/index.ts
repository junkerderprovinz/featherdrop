// To add a language, create ./<code>.ts exporting a Translation, whose type
// enforces the full key set, then add it to LANGUAGES and resources below.
// test/locales.test.ts checks that no key is missing or empty.
import { en, type TranslationKey, type Translation } from "./en";
import { de } from "./de";
import { fr } from "./fr";
import { es } from "./es";
import { it } from "./it";
import { pt } from "./pt";
import { nl } from "./nl";
import { pl } from "./pl";
import { ru } from "./ru";
import { uk } from "./uk";
import { cs } from "./cs";
import { sv } from "./sv";
import { da } from "./da";
import { fi } from "./fi";
import { no } from "./no";
import { tr } from "./tr";
import { el } from "./el";
import { hu } from "./hu";
import { ro } from "./ro";
import { ja } from "./ja";
import { ko } from "./ko";
import { zh } from "./zh";
import { ar } from "./ar";
import { he } from "./he";
import { th } from "./th";
import { vi } from "./vi";

export type { TranslationKey, Translation };

export interface Language {
  code: string;
  label: string; // the language's own name
  flag: string; // ISO 3166-1 alpha-2 region code of the flag
  rtl?: boolean;
}

// Order here is the order shown in the language menu.
export const LANGUAGES: Language[] = [
  { code: "en", label: "English", flag: "gb" },
  { code: "de", label: "Deutsch", flag: "de" },
  { code: "fr", label: "Français", flag: "fr" },
  { code: "es", label: "Español", flag: "es" },
  { code: "it", label: "Italiano", flag: "it" },
  { code: "pt", label: "Português", flag: "pt" },
  { code: "nl", label: "Nederlands", flag: "nl" },
  { code: "pl", label: "Polski", flag: "pl" },
  { code: "ru", label: "Русский", flag: "ru" },
  { code: "uk", label: "Українська", flag: "ua" },
  { code: "cs", label: "Čeština", flag: "cz" },
  { code: "sv", label: "Svenska", flag: "se" },
  { code: "da", label: "Dansk", flag: "dk" },
  { code: "fi", label: "Suomi", flag: "fi" },
  { code: "no", label: "Norsk", flag: "no" },
  { code: "tr", label: "Türkçe", flag: "tr" },
  { code: "el", label: "Ελληνικά", flag: "gr" },
  { code: "hu", label: "Magyar", flag: "hu" },
  { code: "ro", label: "Română", flag: "ro" },
  { code: "ja", label: "日本語", flag: "jp" },
  { code: "ko", label: "한국어", flag: "kr" },
  { code: "zh", label: "中文", flag: "cn" },
  { code: "ar", label: "العربية", flag: "sa", rtl: true },
  { code: "he", label: "עברית", flag: "il", rtl: true },
  { code: "th", label: "ไทย", flag: "th" },
  { code: "vi", label: "Tiếng Việt", flag: "vn" },
];

export const DEFAULT_LANGUAGE = "en";

export const SUPPORTED = LANGUAGES.map((l) => l.code);

/** Whether a language is written right to left, such as Arabic or Hebrew. */
export const isRtl = (code: string): boolean =>
  LANGUAGES.find((l) => l.code === code)?.rtl ?? false;

export const resources: Record<string, Translation> = {
  en, de, fr, es, it, pt, nl, pl, ru, uk, cs, sv, da, fi, no,
  tr, el, hu, ro, ja, ko, zh, ar, he, th, vi,
};
