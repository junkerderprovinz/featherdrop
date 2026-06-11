import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isValidKeyVerifier, verifierMatches } from "../lib/key-verifier";

// A real verifier: base64url(SHA-256(32-byte key)) — always 43 chars, unpadded.
const GOOD = createHash("sha256").update(Buffer.alloc(32, 0)).digest("base64url");

// ---------------------------------------------------------------------------
// isValidKeyVerifier — the finalize-body validation rule
// ---------------------------------------------------------------------------

test("isValidKeyVerifier accepts a 43-char base64url string", () => {
  assert.equal(GOOD.length, 43, "sanity: SHA-256 base64url-unpadded is 43 chars");
  assert.equal(isValidKeyVerifier(GOOD), true);
  // All base64url alphabet classes, including '-' and '_'.
  assert.equal(isValidKeyVerifier("Aa0-_".repeat(8) + "Aa0"), true);
});

test("isValidKeyVerifier rejects non-strings", () => {
  for (const bad of [undefined, null, 42, true, {}, [], Buffer.alloc(43)]) {
    assert.equal(isValidKeyVerifier(bad), false, `must reject ${typeof bad}`);
  }
});

test("isValidKeyVerifier rejects wrong lengths", () => {
  assert.equal(isValidKeyVerifier(""), false);
  assert.equal(isValidKeyVerifier(GOOD.slice(0, 42)), false, "42 chars");
  assert.equal(isValidKeyVerifier(GOOD + "A"), false, "44 chars");
});

test("isValidKeyVerifier rejects non-base64url characters", () => {
  // '+' and '/' are standard-base64-only; '=' is padding; others are junk.
  for (const ch of ["+", "/", "=", " ", ".", "!", "\n"]) {
    const s = GOOD.slice(0, 42) + ch;
    assert.equal(s.length, 43);
    assert.equal(isValidKeyVerifier(s), false, `must reject ${JSON.stringify(ch)}`);
  }
});

// ---------------------------------------------------------------------------
// verifierMatches — the constant-time comparison used by the download GET
// ---------------------------------------------------------------------------

test("verifierMatches accepts the exact stored value", () => {
  assert.equal(verifierMatches(GOOD, GOOD), true);
});

test("verifierMatches rejects a same-length different value", () => {
  const other = createHash("sha256")
    .update(Buffer.alloc(32, 1))
    .digest("base64url");
  assert.equal(other.length, GOOD.length);
  assert.equal(verifierMatches(other, GOOD), false);
});

test("verifierMatches rejects on length mismatch without throwing", () => {
  // timingSafeEqual throws on unequal-length buffers; the helper must instead
  // burn a dummy comparison and return false (no exception, no timing shortcut).
  assert.equal(verifierMatches("", GOOD), false);
  assert.equal(verifierMatches(GOOD.slice(0, 10), GOOD), false);
  assert.equal(verifierMatches(GOOD + GOOD, GOOD), false);
});

test("verifierMatches rejects a single-character difference", () => {
  const flipped =
    (GOOD[0] === "A" ? "B" : "A") + GOOD.slice(1);
  assert.equal(verifierMatches(flipped, GOOD), false);
});
