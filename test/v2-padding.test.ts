import { test } from "node:test";
import assert from "node:assert/strict";
import {
  padme,
  paddedContentLength,
  paddedHeaderLength,
  MIN_CONTENT_PAD,
  MIN_HEADER_PAD,
} from "../lib/e2e/v2/padding";

test("padme rounds to the expected buckets", () => {
  // Worked out by hand: keep the top floor(log2 E) + 1 bits of the length.
  const cases: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [9, 10],
    [100, 104],
    [1000, 1024],
    [1025, 1088],
    [65537, 67584],
    [1_000_000, 1_015_808],
    [2 ** 40 + 1, 2 ** 40 + 2 ** 34],
  ];
  for (const [len, want] of cases) assert.equal(padme(len), want, `padme(${len})`);
});

test("padme never shrinks and stays within its overhead bound", () => {
  for (let len = 2; len < 300_000; len += 997) {
    const p = padme(len);
    assert.ok(p >= len);
    const e = Math.floor(Math.log2(len));
    assert.ok(p - len < 2 ** (e - Math.floor(Math.log2(e)) - 1), `padme(${len}) = ${p}`);
  }
});

test("padme keeps exact values for large sizes beyond 32 bits", () => {
  const len = 2 ** 52 - 1;
  assert.equal(padme(len), 2 ** 52);
});

test("content padding hides sizes below the minimum", () => {
  assert.equal(paddedContentLength(0), MIN_CONTENT_PAD);
  assert.equal(paddedContentLength(1), MIN_CONTENT_PAD);
  assert.equal(paddedContentLength(MIN_CONTENT_PAD), MIN_CONTENT_PAD);
  assert.equal(paddedContentLength(MIN_CONTENT_PAD + 1), padme(MIN_CONTENT_PAD + 1));
});

test("header padding hides short names and small file counts", () => {
  assert.equal(paddedHeaderLength(40), MIN_HEADER_PAD);
  assert.equal(paddedHeaderLength(MIN_HEADER_PAD + 100), padme(MIN_HEADER_PAD + 100));
});

test("padding rejects negative and fractional lengths", () => {
  assert.throws(() => padme(-1));
  assert.throws(() => padme(1.5));
});
