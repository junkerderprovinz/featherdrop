import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptStream,
  decryptStream,
  wrapKey,
  unwrapKey,
} from "../server/crypto";

// --- helpers: bytes <-> ReadableStream ---------------------------------------
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);
const HEADER = { name: "résumé final.pdf", mime: "application/pdf" };
const BODY = enc("the quick brown featherdrop jumps over the lazy share");

// --- single-path file encryption (always to a per-file key) ------------------
test("round-trip recovers the exact bytes and header", async () => {
  const { ciphertext, key } = await encryptStream(streamOf(BODY), HEADER);
  assert.equal(typeof key, "string");
  assert.ok(key.length > 0);

  const { header, plaintext } = await decryptStream(ciphertext, key);
  assert.deepEqual(header, HEADER);
  assert.deepEqual(await collect(plaintext), BODY);
});

test("a different key cannot decrypt", async () => {
  const a = await encryptStream(streamOf(BODY), HEADER);
  const b = await encryptStream(streamOf(BODY), HEADER);
  await assert.rejects(() => decryptStream(a.ciphertext, b.key));
});

test("the ciphertext does not contain the filename or body in clear text", async () => {
  const { ciphertext } = await encryptStream(streamOf(BODY), HEADER);
  const bytes = await collect(ciphertext);
  const haystack = new TextDecoder("latin1").decode(bytes);
  assert.ok(!haystack.includes("résumé"), "filename leaked into ciphertext");
  assert.ok(
    !haystack.includes("featherdrop jumps"),
    "body leaked into ciphertext",
  );
});

test("a tampered ciphertext byte makes decryption fail", async () => {
  const { ciphertext, key } = await encryptStream(streamOf(BODY), HEADER);
  const bytes = await collect(ciphertext);
  bytes[bytes.length - 1] ^= 0xff; // flip the last byte
  await assert.rejects(() =>
    decryptStream(streamOf(bytes), key).then((r) => collect(r.plaintext)),
  );
});

test("a payload larger than one STREAM chunk round-trips", async () => {
  const big = new Uint8Array(200_000).map((_, i) => i % 251);
  const { ciphertext, key } = await encryptStream(streamOf(big), HEADER);
  const { plaintext } = await decryptStream(ciphertext, key);
  assert.deepEqual(await collect(plaintext), big);
});

// --- password-wrapping of the file key (envelope) ----------------------------
test("wrap/unwrap recovers the file key with the right password", async () => {
  const { key } = await encryptStream(streamOf(BODY), HEADER);
  const wrapped = await wrapKey(key, "correct horse");
  assert.notEqual(wrapped, key, "wrapped key must not equal the bare key");
  assert.equal(await unwrapKey(wrapped, "correct horse"), key);
});

test("unwrapping with the wrong password throws", async () => {
  const { key } = await encryptStream(streamOf(BODY), HEADER);
  const wrapped = await wrapKey(key, "correct horse");
  await assert.rejects(() => unwrapKey(wrapped, "battery staple"));
});

test("a wrapped key can be unwrapped and then used to decrypt the file", async () => {
  const { ciphertext, key } = await encryptStream(streamOf(BODY), HEADER);
  const wrapped = await wrapKey(key, "pw");
  const recovered = await unwrapKey(wrapped, "pw");
  const { header, plaintext } = await decryptStream(ciphertext, recovered);
  assert.deepEqual(header, HEADER);
  assert.deepEqual(await collect(plaintext), BODY);
});

test("the wrapped key does not contain the bare key in clear text", async () => {
  const { key } = await encryptStream(streamOf(BODY), HEADER);
  const wrapped = await wrapKey(key, "pw");
  assert.ok(!wrapped.includes(key), "bare key leaked into the wrapped blob");
});
