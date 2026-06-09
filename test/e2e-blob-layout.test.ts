// test/e2e-blob-layout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeVarint,
  decodeVarint,
  assembleBlob,
  readBlobMeta,
} from "../lib/e2e/blob-layout";

async function* one(b: Uint8Array) {
  yield b;
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

for (const n of [0, 1, 127, 128, 300, 16384, 1_000_000]) {
  test(`varint round-trips ${n}`, () => {
    const enc = encodeVarint(n);
    const { value, bytesRead } = decodeVarint(enc, 0);
    assert.equal(value, n);
    assert.equal(bytesRead, enc.length);
  });
}

test("assembleBlob + readBlobMeta round-trip (meta + content)", async () => {
  const meta = new Uint8Array([1, 2, 3, 4, 5]);
  const content = new Uint8Array(200).map((_, i) => i % 251);
  const blob = await collect(assembleBlob(meta, one(content)));
  const { encMeta, content: rest } = await readBlobMeta(one(blob));
  assert.deepEqual(encMeta, meta);
  assert.deepEqual(await collect(rest), content);
});

test("readBlobMeta works when input arrives in tiny pieces", async () => {
  const meta = new Uint8Array(300).map((_, i) => (i * 3) % 251);
  const content = new Uint8Array(50).fill(9);
  const blob = await collect(assembleBlob(meta, one(content)));
  async function* drip() {
    for (let i = 0; i < blob.length; i += 7) yield blob.subarray(i, i + 7);
  }
  const { encMeta, content: rest } = await readBlobMeta(drip());
  assert.deepEqual(encMeta, meta);
  assert.deepEqual(await collect(rest), content);
});

test("readBlobMeta throws on truncated header", async () => {
  await assert.rejects(() => readBlobMeta(one(new Uint8Array(0))));
});
