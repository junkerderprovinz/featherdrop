import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, generateKey, encodeKey, decodeKey } from "../lib/e2e/crypto";

before(async () => {
  await ready();
});

test("generateKey returns a 32-byte key and is random", () => {
  const a = generateKey();
  const b = generateKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

test("encodeKey/decodeKey round-trips (base64url, no padding)", () => {
  const k = generateKey();
  const s = encodeKey(k);
  assert.match(s, /^[A-Za-z0-9_-]+$/); // url-safe, no '+', '/', '='
  assert.deepEqual(decodeKey(s), k);
});
