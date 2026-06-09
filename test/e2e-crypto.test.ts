import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, generateKey, encodeKey, decodeKey, encryptMeta, decryptMeta } from "../lib/e2e/crypto";

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

test("encryptMeta/decryptMeta round-trips name + type", () => {
  const key = generateKey();
  const blob = encryptMeta({ name: "résumé final.pdf", type: "application/pdf" }, key);
  assert.deepEqual(decryptMeta(blob, key), {
    name: "résumé final.pdf",
    type: "application/pdf",
  });
});

test("decryptMeta with the wrong key throws", () => {
  const blob = encryptMeta({ name: "a.png", type: "image/png" }, generateKey());
  assert.throws(() => decryptMeta(blob, generateKey()));
});

test("enc_meta does not leak the filename in cleartext", () => {
  const blob = encryptMeta({ name: "secret-name.txt", type: "text/plain" }, generateKey());
  const hay = new TextDecoder("latin1").decode(blob);
  assert.ok(!hay.includes("secret-name"));
});
