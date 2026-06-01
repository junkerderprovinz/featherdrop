import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAcceptLanguage } from "../lib/i18n/detect";

test("parses a simple list preserving order", () => {
  assert.deepEqual(parseAcceptLanguage("de-AT,de;q=0.9,en;q=0.8"), [
    "de-AT",
    "de",
    "en",
  ]);
});

test("sorts by q-value descending, default q=1 wins", () => {
  assert.deepEqual(parseAcceptLanguage("fr;q=0.2,de;q=0.9,en"), [
    "en",
    "de",
    "fr",
  ]);
});

test("tolerates whitespace", () => {
  assert.deepEqual(parseAcceptLanguage("en-US, en;q=0.5"), ["en-US", "en"]);
});

test("drops the wildcard", () => {
  assert.deepEqual(parseAcceptLanguage("en;q=0.9,*;q=0.1"), ["en"]);
});

test("empty / missing header -> empty list", () => {
  assert.deepEqual(parseAcceptLanguage(""), []);
  assert.deepEqual(parseAcceptLanguage(null), []);
  assert.deepEqual(parseAcceptLanguage(undefined), []);
});

test("ignores malformed q values, treating them as default", () => {
  // q=abc is invalid -> treated as q=1 (kept, original order among equals)
  assert.deepEqual(parseAcceptLanguage("de;q=abc,en;q=0.5"), ["de", "en"]);
});

test("is a stable sort for equal q values", () => {
  assert.deepEqual(parseAcceptLanguage("a,b,c"), ["a", "b", "c"]);
});
