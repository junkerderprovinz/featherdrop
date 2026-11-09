// Looks texts up by dotted key, such as "home.choose". A text a language lacks
// falls back to English, and a key no table has shows itself, so a gap is easy
// to spot on the page.
import { DEFAULT_LANGUAGE, localeOf } from "./languages";
import { tables, type Table } from "./locales/index";

export type Params = Record<string, string | number>;

function lookup(table: Table | undefined, key: string): string | Table | undefined {
  let at: string | Table | undefined = table;
  for (const part of key.split(".")) at = typeof at === "object" ? at[part] : undefined;
  return at;
}

const chain = (lang: string) => (lang === DEFAULT_LANGUAGE ? [lang] : [lang, DEFAULT_LANGUAGE]);

const fill = (text: string, params: Params) =>
  text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));

export function translate(lang: string, key: string, params: Params = {}): string {
  for (const code of chain(lang)) {
    const text = lookup(tables[code], key);
    if (typeof text === "string" && text) return fill(text, params);
  }
  return key;
}

/** A counted text: key names its forms by plural category, and {n} arrives written the language's way. */
export function plural(lang: string, n: number, key: string, params: Params = {}): string {
  for (const code of chain(lang)) {
    const forms = lookup(tables[code], key);
    if (typeof forms !== "object") continue;
    const locale = localeOf(code);
    const form = n === 0 && typeof forms.zero === "string" ? "zero" : new Intl.PluralRules(locale).select(n);
    const text = forms[form] ?? forms.other;
    if (typeof text === "string") return fill(text, { n: n.toLocaleString(locale), ...params });
  }
  return key;
}
