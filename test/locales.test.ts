import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, localeOf } from "../lib/i18n/languages";
import { tables, type Table } from "../lib/i18n/locales/index";
import { plural, translate } from "../lib/i18n/translate";

const codes = LANGUAGES.map((l) => l.code);
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

// A plural group is an object whose keys are plural categories; everything
// else is a namespace of further keys.
const CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const isPlural = (v: string | Table): v is Table =>
  typeof v === "object" && Object.keys(v).every((k) => CATEGORIES.has(k)) && "other" in v;

function leaves(table: Table, prefix = ""): Map<string, string | Table> {
  const out = new Map<string, string | Table>();
  for (const [k, v] of Object.entries(table)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string" || isPlural(v)) out.set(path, v);
    else for (const [p, x] of leaves(v, path)) out.set(p, x);
  }
  return out;
}

const texts = (v: string | Table) => (typeof v === "string" ? [v] : (Object.values(v) as string[]));
const english = leaves(tables.en);

test("all 42 languages ship, each with a table", () => {
  assert.equal(codes.length, 42);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.ok(tables[code], `no table for ${code}`);
});

test("only Arabic, Persian and Hebrew are written right to left", () => {
  assert.deepEqual(LANGUAGES.filter((l) => l.rtl).map((l) => l.code).sort(), ["ar", "fa", "he"]);
});

test("every language has exactly the English keys, none empty", () => {
  for (const code of codes) {
    const own = leaves(tables[code]);
    assert.deepEqual([...own.keys()].sort(), [...english.keys()].sort(), `keys of ${code}`);
    for (const [key, value] of own) {
      for (const text of texts(value)) assert.ok(text.trim(), `empty ${code}.${key}`);
    }
  }
});

test("every plural text has the forms its language needs", () => {
  for (const code of codes) {
    const needed = new Intl.PluralRules(localeOf(code)).resolvedOptions().pluralCategories;
    for (const [key, value] of leaves(tables[code])) {
      if (typeof value === "string") continue;
      for (const form of needed) assert.ok(form in value, `${code}.${key} lacks "${form}"`);
    }
  }
});

test("translations use no placeholder the English text lacks", () => {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  for (const code of codes) {
    for (const [key, value] of leaves(tables[code])) {
      const want = texts(english.get(key)!).flatMap(names);
      for (const name of texts(value).flatMap(names)) assert.ok(want.includes(name), `${code}.${key} invents {${name}}`);
    }
  }
});

test("no interface text uses a dash outside Cyrillic, and English uses no semicolon", () => {
  for (const code of codes) {
    if (code === "ru" || code === "uk") continue;
    for (const [key, value] of leaves(tables[code])) {
      for (const text of texts(value)) assert.ok(!DASHES.test(text), `dash in ${code}.${key}`);
    }
  }
  for (const [key, value] of english) {
    for (const text of texts(value)) assert.ok(!text.includes(";"), `semicolon in en.${key}`);
  }
});

test("a text is looked up by its dotted key and filled in", () => {
  assert.equal(translate("en", "home.choose"), "Choose files");
  assert.equal(translate("en", "options.total", { count: "2 files", size: "4 MB" }), "2 files, 4 MB in all");
});

test("a key a language lacks falls back to English, and an unknown key shows itself", () => {
  assert.equal(translate("xx", "home.choose"), "Choose files");
  assert.equal(translate("de", "no.such.key"), "no.such.key");
});

test("a counted text takes the form of the language's plural rules", () => {
  assert.equal(plural("en", 1, "common.files"), "1 file");
  assert.equal(plural("en", 3, "common.files"), "3 files");
  assert.equal(plural("de", 2, "common.files"), "2 Dateien");
  assert.notEqual(plural("pl", 2, "common.files"), plural("pl", 5, "common.files"));
});

test("the count in a plural is written the language's way", () => {
  assert.equal(plural("de", 1500, "common.files"), `${(1500).toLocaleString(localeOf("de"))} Dateien`);
  assert.notEqual(plural("de", 1500, "common.files"), "1500 Dateien");
});
