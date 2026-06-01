import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadsLeft, isExhausted, parseMaxDownloads } from "../lib/downloads";

// Optional download limit / burn-after-download. max_downloads is null for
// "unlimited"; a positive integer caps the number of downloads, after which the
// file + its row are deleted (the atomic part lives in server/db.ts).

test("downloadsLeft: null max means unlimited", () => {
  assert.equal(downloadsLeft(5, null), null);
});

test("downloadsLeft: remaining = max - count, never below 0", () => {
  assert.equal(downloadsLeft(0, 3), 3);
  assert.equal(downloadsLeft(2, 3), 1);
  assert.equal(downloadsLeft(3, 3), 0);
  assert.equal(downloadsLeft(5, 3), 0);
});

test("isExhausted: true once count reaches a finite max", () => {
  assert.equal(isExhausted(0, null), false);
  assert.equal(isExhausted(9, null), false);
  assert.equal(isExhausted(0, 1), false);
  assert.equal(isExhausted(1, 1), true);
  assert.equal(isExhausted(3, 3), true);
  assert.equal(isExhausted(4, 3), true);
});

test("parseMaxDownloads: a valid positive integer passes through", () => {
  assert.equal(parseMaxDownloads(1), 1);
  assert.equal(parseMaxDownloads(10), 10);
});

test("parseMaxDownloads: unset/zero/negative/non-integer -> null (unlimited)", () => {
  assert.equal(parseMaxDownloads(null), null);
  assert.equal(parseMaxDownloads(undefined), null);
  assert.equal(parseMaxDownloads(0), null);
  assert.equal(parseMaxDownloads(-3), null);
  assert.equal(parseMaxDownloads(2.5), null);
  assert.equal(parseMaxDownloads(Number.NaN), null);
});

test("parseMaxDownloads: caps absurdly large values", () => {
  assert.equal(parseMaxDownloads(1_000_000), 10_000);
});
