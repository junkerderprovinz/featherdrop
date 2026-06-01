import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLanguage } from "../lib/i18n/detect";

const SUPPORTED = ["en", "de", "fr"];
const FALLBACK = "en";

test("picks an exact supported language", () => {
  assert.equal(resolveLanguage(["de"], SUPPORTED, FALLBACK), "de");
});

test("maps a region variant to its base language (de-AT -> de)", () => {
  assert.equal(resolveLanguage(["de-AT"], SUPPORTED, FALLBACK), "de");
});

test("is case-insensitive (DE-de -> de)", () => {
  assert.equal(resolveLanguage(["DE-de"], SUPPORTED, FALLBACK), "de");
});

test("honours candidate priority order (first supported wins)", () => {
  assert.equal(resolveLanguage(["fr", "de"], SUPPORTED, FALLBACK), "fr");
});

test("skips unsupported candidates and takes the next supported one", () => {
  assert.equal(resolveLanguage(["xx", "de"], SUPPORTED, FALLBACK), "de");
});

test("falls back when no candidate is supported", () => {
  assert.equal(resolveLanguage(["xx", "zz"], SUPPORTED, FALLBACK), "en");
});

test("falls back on empty input", () => {
  assert.equal(resolveLanguage([], SUPPORTED, FALLBACK), "en");
});

test("ignores empty / malformed entries", () => {
  assert.equal(resolveLanguage(["", "  ", "de"], SUPPORTED, FALLBACK), "de");
});

test("prefers an exact region-specific match over a base fallback when both candidates exist", () => {
  // pt-BR not supported, but pt is — region strips to base
  assert.equal(resolveLanguage(["pt-BR"], ["en", "pt"], FALLBACK), "pt");
});
