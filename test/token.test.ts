import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadToken, tokenMatches } from "../lib/token";

const HASH = "scrypt$00112233$deadbeefcafebabe";

test("downloadToken is deterministic and hash-derived", () => {
  assert.equal(downloadToken(HASH), downloadToken(HASH));
  assert.notEqual(downloadToken(HASH), downloadToken(HASH + "x"));
});

test("tokenMatches accepts the correct hash-derived token", () => {
  assert.equal(tokenMatches(downloadToken(HASH), HASH), true);
});

test("tokenMatches rejects a missing cookie", () => {
  assert.equal(tokenMatches(undefined, HASH), false);
  assert.equal(tokenMatches("", HASH), false);
});

test("tokenMatches rejects an arbitrary forged value (the bypass)", () => {
  // The vulnerability was authorizing on presence alone: any non-empty cookie
  // passed. A forged value must be rejected.
  assert.equal(tokenMatches("x", HASH), false);
  assert.equal(tokenMatches("1", HASH), false);
  assert.equal(tokenMatches("anything", HASH), false);
});

test("tokenMatches rejects the public slug (the original forgery vector)", () => {
  assert.equal(tokenMatches("k7Mx9qT2", HASH), false);
});

test("tokenMatches rejects a token derived from a different hash", () => {
  assert.equal(tokenMatches(downloadToken(HASH + "other"), HASH), false);
});
