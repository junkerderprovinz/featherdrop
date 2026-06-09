import { test, before } from "node:test";
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers-sumo";
import { ready, generateKey, encodeKey, decodeKey, encryptMeta, decryptMeta, encryptChunks, decryptChunks, PT_CHUNK, wrapKey, unwrapKey } from "../lib/e2e/crypto";

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

// helpers
async function* one(bytes: Uint8Array) {
  yield bytes;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let len = 0;
  for await (const p of it) {
    parts.push(p);
    len += p.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function bytes(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + 3) % 251);
}

for (const size of [0, 1, 100, PT_CHUNK - 1, PT_CHUNK, PT_CHUNK + 1, PT_CHUNK * 3 + 17]) {
  test(`content round-trips at ${size} bytes`, async () => {
    const key = generateKey();
    const data = bytes(size);
    const cipher = await collect(encryptChunks(one(data), key));
    const plain = await collect(decryptChunks(one(cipher), key));
    assert.deepEqual(plain, data);
  });
}

test("decrypt with the wrong key throws", async () => {
  const cipher = await collect(encryptChunks(one(bytes(5000)), generateKey()));
  await assert.rejects(() => collect(decryptChunks(one(cipher), generateKey())));
});

test("a flipped ciphertext byte throws", async () => {
  const key = generateKey();
  const cipher = await collect(encryptChunks(one(bytes(5000)), key));
  cipher[cipher.length - 1] ^= 0xff;
  await assert.rejects(() => collect(decryptChunks(one(cipher), key)));
});

test("truncation (missing final frame) throws", async () => {
  const key = generateKey();
  // 2 full chunks + a final → drop the last (final) frame entirely
  const cipher = await collect(encryptChunks(one(bytes(PT_CHUNK * 2 + 10)), key));
  const truncated = cipher.subarray(0, 24 + (PT_CHUNK + 17) * 2); // header + 2 full frames, no final
  await assert.rejects(() => collect(decryptChunks(one(truncated), key)));
});

test("ciphertext does not contain the plaintext", async () => {
  const key = generateKey();
  const marker = sodium.from_string("FEATHERDROP_SECRET_MARKER");
  const cipher = await collect(encryptChunks(one(marker), key));
  const hay = new TextDecoder("latin1").decode(cipher);
  assert.ok(!hay.includes("FEATHERDROP_SECRET_MARKER"));
});

test("wrapKey/unwrapKey round-trips with the right password", () => {
  const key = generateKey();
  const { wrapped, salt } = wrapKey(key, "correct horse battery staple");
  assert.deepEqual(unwrapKey(wrapped, salt, "correct horse battery staple"), key);
});

test("unwrapKey with the wrong password throws", () => {
  const { wrapped, salt } = wrapKey(generateKey(), "right");
  assert.throws(() => unwrapKey(wrapped, salt, "wrong"));
});

test("wrapped key does not contain the bare key", () => {
  const key = generateKey();
  const { wrapped } = wrapKey(key, "pw");
  const hay = new TextDecoder("latin1").decode(wrapped);
  assert.ok(!hay.includes(new TextDecoder("latin1").decode(key)));
});
