import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLanguage } from "../lib/i18n/detect";

const SUPPORTED = ["en", "de", "fr", "ar"];
const FALLBACK = "en";

test("cookie choice wins over the Accept-Language header", () => {
  assert.equal(
    pickLanguage("fr", "de-DE,de;q=0.9", SUPPORTED, FALLBACK),
    "fr",
  );
});

test("falls back to the header when there is no cookie", () => {
  assert.equal(
    pickLanguage(null, "de-AT,de;q=0.9,en;q=0.8", SUPPORTED, FALLBACK),
    "de",
  );
});

test("an unsupported cookie does not block a supported header language", () => {
  // cookie "xx" is unsupported -> skipped, header de wins
  assert.equal(pickLanguage("xx", "de", SUPPORTED, FALLBACK), "de");
});

test("respects header q-ordering", () => {
  assert.equal(
    pickLanguage(null, "fr;q=0.3,de;q=0.9", SUPPORTED, FALLBACK),
    "de",
  );
});

test("falls back when nothing is supported", () => {
  assert.equal(pickLanguage(null, "xx,zz", SUPPORTED, FALLBACK), "en");
});

test("falls back when both cookie and header are absent", () => {
  assert.equal(pickLanguage(null, null, SUPPORTED, FALLBACK), "en");
});

test("resolves an RTL language so the layout can flip direction", () => {
  assert.equal(pickLanguage("ar", null, SUPPORTED, FALLBACK), "ar");
});
