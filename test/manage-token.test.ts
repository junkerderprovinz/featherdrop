import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  hashManageToken,
  isValidManageToken,
  isValidManageTokenHash,
  manageTokenMatches,
  newManageToken,
} from "../lib/manage-token";

// ---------------------------------------------------------------------------
// newManageToken — a fresh, well-formed 32-byte base64url token
// ---------------------------------------------------------------------------

test("newManageToken is a 43-char unpadded base64url string", () => {
  const tok = newManageToken();
  assert.equal(tok.length, 43, "32 bytes base64url-unpadded is 43 chars");
  assert.match(tok, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!tok.includes("="), "must be unpadded");
  assert.ok(isValidManageToken(tok));
});

test("newManageToken returns a fresh value each call", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) seen.add(newManageToken());
  assert.equal(seen.size, 100, "all 100 tokens must be distinct");
});

// ---------------------------------------------------------------------------
// hashManageToken — base64url(SHA-256(token)), one-way and stable
// ---------------------------------------------------------------------------

test("hashManageToken is base64url(SHA-256(token))", () => {
  const tok = newManageToken();
  const expected = createHash("sha256").update(tok).digest("base64url");
  assert.equal(hashManageToken(tok), expected);
  assert.equal(hashManageToken(tok).length, 43, "SHA-256 base64url is 43 chars");
});

test("hashManageToken is deterministic and differs per token", () => {
  const a = newManageToken();
  const b = newManageToken();
  assert.equal(hashManageToken(a), hashManageToken(a), "stable for same input");
  assert.notEqual(hashManageToken(a), hashManageToken(b), "differs per token");
});

test("the hash is not the raw token (server stores only the hash)", () => {
  const tok = newManageToken();
  assert.notEqual(hashManageToken(tok), tok);
});

// ---------------------------------------------------------------------------
// isValidManageToken / isValidManageTokenHash — shape checks
// ---------------------------------------------------------------------------

test("isValidManageToken accepts a 43-char base64url string", () => {
  assert.equal(isValidManageToken("Aa0-_".repeat(8) + "Aa0"), true);
});

test("isValidManageToken rejects bad shapes", () => {
  for (const bad of [undefined, null, 42, true, {}, "", "short", "A".repeat(44)]) {
    assert.equal(isValidManageToken(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  for (const ch of ["+", "/", "=", " ", "."]) {
    assert.equal(isValidManageToken("A".repeat(42) + ch), false, `rejects ${ch}`);
  }
});

test("isValidManageTokenHash accepts a 43-char base64url string", () => {
  assert.equal(isValidManageTokenHash(hashManageToken(newManageToken())), true);
  assert.equal(isValidManageTokenHash("A".repeat(43)), true);
  assert.equal(isValidManageTokenHash("A".repeat(42)), false);
});

// ---------------------------------------------------------------------------
// manageTokenMatches — constant-time check of raw token vs stored hash
// ---------------------------------------------------------------------------

test("manageTokenMatches accepts the token whose hash was stored", () => {
  const tok = newManageToken();
  const stored = hashManageToken(tok);
  assert.equal(manageTokenMatches(tok, stored), true);
});

test("manageTokenMatches rejects a different token", () => {
  const stored = hashManageToken(newManageToken());
  assert.equal(manageTokenMatches(newManageToken(), stored), false);
});

test("manageTokenMatches rejects a NULL/empty stored hash (legacy share)", () => {
  const tok = newManageToken();
  assert.equal(manageTokenMatches(tok, null), false, "legacy null hash");
  assert.equal(manageTokenMatches(tok, ""), false, "empty hash");
});

test("manageTokenMatches rejects a missing/empty provided token", () => {
  const stored = hashManageToken(newManageToken());
  assert.equal(manageTokenMatches(undefined, stored), false);
  assert.equal(manageTokenMatches("", stored), false);
});

test("manageTokenMatches does not throw on a length mismatch", () => {
  const stored = hashManageToken(newManageToken());
  // The provided value hashes to 43 chars regardless, but feed a stored hash of
  // the wrong length to exercise the dummy-compare branch (no throw, returns false).
  assert.equal(manageTokenMatches(newManageToken(), "A".repeat(10)), false);
  assert.equal(manageTokenMatches(newManageToken(), "A".repeat(80)), false);
});
