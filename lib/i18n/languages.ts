// Every language the client speaks, each under its own name, ordered by that
// name as Wikipedia lists its editions.
export interface LanguageInfo {
  code: string;
  name: string;
  /** The flag-icons country code shown beside the name. */
  flag: string;
  /** Where the bare code would pick another country's way of writing dates and numbers. */
  locale?: string;
  rtl?: boolean;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: "cs", name: "Čeština", flag: "cz" },
  { code: "da", name: "Dansk", flag: "dk" },
  { code: "de", name: "Deutsch", flag: "de", locale: "de-AT" },
  { code: "en", name: "English", flag: "gb", locale: "en-GB" },
  { code: "es", name: "Español", flag: "es" },
  { code: "fr", name: "Français", flag: "fr" },
  { code: "it", name: "Italiano", flag: "it" },
  { code: "hu", name: "Magyar", flag: "hu" },
  { code: "nl", name: "Nederlands", flag: "nl" },
  { code: "no", name: "Norsk", flag: "no", locale: "nb" },
  { code: "pl", name: "Polski", flag: "pl" },
  { code: "pt", name: "Português", flag: "pt", locale: "pt-PT" },
  { code: "ro", name: "Română", flag: "ro" },
  { code: "fi", name: "Suomi", flag: "fi" },
  { code: "sv", name: "Svenska", flag: "se" },
  { code: "vi", name: "Tiếng Việt", flag: "vn" },
  { code: "tr", name: "Türkçe", flag: "tr" },
  { code: "el", name: "Ελληνικά", flag: "gr" },
  { code: "ru", name: "Русский", flag: "ru" },
  { code: "uk", name: "Українська", flag: "ua" },
  { code: "he", name: "עברית", flag: "il", rtl: true },
  { code: "ar", name: "العربية", flag: "sa", rtl: true },
  { code: "th", name: "ไทย", flag: "th" },
  { code: "ko", name: "한국어", flag: "kr" },
  { code: "zh", name: "中文", flag: "cn", locale: "zh-CN" },
  { code: "ja", name: "日本語", flag: "jp" },
];

export const DEFAULT_LANGUAGE = "en";

export const SUPPORTED = LANGUAGES.map((l) => l.code);

const infoOf = (code: string) => LANGUAGES.find((l) => l.code === code);

/** The BCP 47 locale that formats numbers and dates for a language. */
export const localeOf = (code: string): string => infoOf(code)?.locale ?? code;

export const isRtl = (code: string): boolean => infoOf(code)?.rtl ?? false;
