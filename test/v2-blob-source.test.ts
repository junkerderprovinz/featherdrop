import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKeys } from "../lib/e2e/v2/keys";
import { buildEncryptor, encryptStream, sealSpan } from "../lib/e2e/v2/share";
import { blobSource as layoutSource, type BlobState, type FileEntry } from "../lib/e2e/v2/layout";

// The page passes a seal that runs in the crypto worker; here it runs inline.
const blobSource = (state: BlobState, read: (start: number, end: number) => Promise<Uint8Array>) =>
  layoutSource(state, read, (s, e, p) => sealSpan(state, s, e, p));

function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + seed) % 251);
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

async function* one(b: Uint8Array) {
  yield b;
}

async function encryptor(files: FileEntry[], chunk = 4096) {
  const keys = await deriveKeys({ mode: "link", secret: new Uint8Array(32).fill(9) });
  return () =>
    buildEncryptor({
      keys,
      kind: files.length === 1 ? "single" : "bundle",
      files,
      chunk,
      headerNonce: new Uint8Array(24).fill(1),
      baseNonce: new Uint8Array(24).fill(2),
    });
}

function reader(plain: Uint8Array) {
  const reads: [number, number][] = [];
  return {
    reads,
    read: async (start: number, end: number) => {
      reads.push([start, end]);
      return plain.slice(start, end);
    },
  };
}

for (const size of [0, 1, 4096, 4096 * 3 + 17, 70_000]) {
  test(`slices of the blob source equal the streamed blob at ${size} bytes`, async () => {
    const plain = bytes(size);
    const make = await encryptor([{ name: "a.bin", type: "", size }]);
    const streamed = await collect(encryptStream(make(), one(plain)));
    const source = blobSource(make().state, reader(plain).read);

    assert.equal(source.size, streamed.length);
    assert.deepEqual(await source.slice(0, source.size), streamed);
    for (const step of [1000, 4112, 5000]) {
      const parts: Uint8Array[] = [];
      for (let at = 0; at < source.size; at += step) parts.push(await source.slice(at, at + step));
      assert.deepEqual(new Uint8Array(Buffer.concat(parts)), streamed, `step ${step}`);
    }
  });
}

test("a bundle's blob source equals its streamed blob", async () => {
  const a = bytes(5000, 1);
  const b = bytes(9000, 2);
  const make = await encryptor([
    { name: "a", type: "", size: a.length },
    { name: "b", type: "", size: b.length },
  ]);
  const plain = new Uint8Array(Buffer.concat([a, b]));
  const streamed = await collect(encryptStream(make(), one(plain)));
  assert.deepEqual(await blobSource(make().state, reader(plain).read).slice(0, streamed.length), streamed);
});

test("a slice from the middle of a chunk returns exactly the rest of the blob", async () => {
  const plain = bytes(4096 * 5 + 300);
  const make = await encryptor([{ name: "a.bin", type: "", size: plain.length }]);
  const streamed = await collect(encryptStream(make(), one(plain)));
  const source = blobSource(make().state, reader(plain).read);
  const offset = streamed.length - 4096 * 2 - 777;

  assert.deepEqual(await source.slice(offset, source.size), streamed.subarray(offset));
});

test("a slice reads only the plaintext of the chunks it covers", async () => {
  const plain = bytes(4096 * 8);
  const make = await encryptor([{ name: "a.bin", type: "", size: plain.length }]);
  const enc = make();
  const r = reader(plain);
  const source = blobSource(enc.state, r.read);
  const third = enc.prefix.length + 2 * (4096 + 16);

  await source.slice(third + 10, third + 20);

  assert.deepEqual(r.reads, [[2 * 4096, 3 * 4096]]);
});

test("a slice past the end stops at the blob length", async () => {
  const plain = bytes(100);
  const make = await encryptor([{ name: "a.bin", type: "", size: plain.length }]);
  const source = blobSource(make().state, reader(plain).read);

  assert.equal((await source.slice(source.size - 5, source.size + 100)).length, 5);
  assert.equal((await source.slice(source.size, source.size + 10)).length, 0);
});

test("plaintext that comes back short fails instead of sealing a wrong chunk", async () => {
  const plain = bytes(10_000);
  const make = await encryptor([{ name: "a.bin", type: "", size: plain.length }]);
  const source = blobSource(make().state, async (s, e) => plain.slice(s, e - 1));

  await assert.rejects(source.slice(0, 100_000), /plaintext/);
});
