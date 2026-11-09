import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKeys, ARGON2ID } from "../lib/e2e/v2/keys";
import type { ShareKeys } from "../lib/e2e/v2/token";
import { aeadEncrypt, toBase64 } from "../lib/e2e/crypto";
import { deriveNonce } from "../lib/e2e/seekable";
import { paddedHeaderLength } from "../lib/e2e/v2/padding";
import {
  createEncryptor,
  buildEncryptor,
  encryptStream,
  openKeys,
  decryptShare,
  ShareDecryptor,
  readHeader,
  decryptRange,
  decryptRangeStream,
  type ShareEncryptor,
} from "../lib/e2e/v2/share";
import { headerLength, cipherRange, type FileEntry } from "../lib/e2e/v2/layout";

async function* one(b: Uint8Array) {
  yield b;
}
async function* pieces(b: Uint8Array, size: number) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}
function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + seed) % 251);
}

const SECRET = new Uint8Array(32).fill(9);
const NONCE_A = new Uint8Array(24).fill(1);
const NONCE_B = new Uint8Array(24).fill(2);

async function encryptAll(enc: ShareEncryptor, plain: Uint8Array): Promise<Uint8Array> {
  return collect(encryptStream(enc, pieces(plain, 10_000)));
}

async function sealed(
  files: FileEntry[],
  plain: Uint8Array,
  opts: { kind?: "single" | "bundle"; chunk?: number; keys?: ShareKeys } = {},
): Promise<{ keys: ShareKeys; blob: Uint8Array }> {
  const keys = opts.keys ?? (await deriveKeys({ mode: "link", secret: SECRET }));
  const enc = buildEncryptor({
    keys,
    kind: opts.kind ?? (files.length === 1 ? "single" : "bundle"),
    files,
    chunk: opts.chunk ?? 4096,
    headerNonce: NONCE_A,
    baseNonce: NONCE_B,
  });
  return { keys, blob: await encryptAll(enc, plain) };
}

async function decryptAll(blob: Uint8Array, keys: ShareKeys) {
  const { header, plaintext } = await decryptShare(pieces(blob, 3000), keys);
  return { header, plain: await collect(plaintext) };
}

for (const size of [0, 1, 4096, 65536, 65536 * 3 + 17]) {
  test(`a single file round-trips in link mode at ${size} bytes`, async () => {
    const data = bytes(size);
    const entry = { name: "Jahresbericht (final).pdf", type: "application/pdf", size };
    const enc = await createEncryptor([entry]);
    const blob = await encryptAll(enc, data);
    assert.equal(blob.length, enc.blobLength);
    const { header, plain } = await decryptAll(blob, await openKeys(enc.token));
    assert.equal(header.kind, "single");
    assert.deepEqual(header.files, [entry]);
    assert.deepEqual(plain, data);
  });
}

test("a bundle round-trips in link mode, empty files included", async () => {
  const files = [
    { name: "a.txt", type: "text/plain", size: 5 },
    { name: "empty", type: "application/octet-stream", size: 0 },
    { name: "b.bin", type: "application/octet-stream", size: 70_000 },
  ];
  const data = bytes(70_005, 3);
  const enc = await createEncryptor(files);
  const blob = await encryptAll(enc, data);
  const { header, plain } = await decryptAll(blob, await openKeys(enc.token));
  assert.equal(header.kind, "bundle");
  assert.deepEqual(header.files, files);
  assert.deepEqual(plain, data);
});

test("a bundle round-trips in link and password mode", async () => {
  const files = [
    { name: "x", type: "", size: 3 },
    { name: "y", type: "", size: 4 },
  ];
  const data = bytes(7);
  const enc = await createEncryptor(files, { password: "correct horse battery" });
  const blob = await encryptAll(enc, data);
  const keys = await openKeys(enc.token, "correct horse battery");
  assert.equal(keys.verifier, enc.verifier);
  const { header, plain } = await decryptAll(blob, keys);
  assert.equal(header.mode, "link+password");
  assert.deepEqual(plain, data);
});

test("a single file round-trips in link and password mode", async () => {
  const data = bytes(9000);
  const enc = await createEncryptor([{ name: "n", type: "t", size: 9000 }], {
    password: "correct horse battery",
  });
  const blob = await encryptAll(enc, data);
  const { plain } = await decryptAll(blob, await openKeys(enc.token, "correct horse battery"));
  assert.deepEqual(plain, data);
});

test("a short password is refused at upload", async () => {
  await assert.rejects(
    createEncryptor([{ name: "n", type: "t", size: 1 }], { password: "short" }),
    /password/,
  );
});

test("a wrong password fails before any content is returned", async () => {
  const enc = await createEncryptor([{ name: "n", type: "t", size: 10 }], {
    password: "correct horse battery",
  });
  const blob = await encryptAll(enc, bytes(10));
  const keys = await openKeys(enc.token, "correct horse batterz");
  assert.notEqual(keys.verifier, enc.verifier);
  await assert.rejects(decryptAll(blob, keys), /header/);
});

test("a wrong link secret fails", async () => {
  const enc = await createEncryptor([{ name: "n", type: "t", size: 10 }]);
  const blob = await encryptAll(enc, bytes(10));
  const other = await createEncryptor([{ name: "n", type: "t", size: 10 }]);
  await assert.rejects(decryptAll(blob, await openKeys(other.token)), /header/);
});

test("the encryptor refuses more or fewer bytes than declared", async () => {
  const entry = { name: "n", type: "t", size: 10 };
  const more = await createEncryptor([entry]);
  await assert.rejects(collect(encryptStream(more, one(bytes(11)))), /size/);
  const fewer = await createEncryptor([entry]);
  await assert.rejects(collect(encryptStream(fewer, one(bytes(9)))), /size/);
});

test("the output does not depend on how the input is split", async () => {
  const files = [{ name: "n", type: "t", size: 9000 }];
  const data = bytes(9000);
  const keys = await deriveKeys({ mode: "link", secret: SECRET });
  const build = () =>
    buildEncryptor({ keys, kind: "single", files, chunk: 4096, headerNonce: NONCE_A, baseNonce: NONCE_B });
  const whole = await collect(encryptStream(build(), one(data)));
  const tiny = await collect(encryptStream(build(), pieces(data, 7)));
  assert.deepEqual(tiny, whole);

  const dec = new ShareDecryptor(keys);
  const out: Uint8Array[] = [];
  for (let i = 0; i < whole.length; i += 1) out.push(...dec.push(whole.subarray(i, i + 1)));
  dec.finish();
  assert.deepEqual(Buffer.concat(out), Buffer.from(data));
});

test("sizes inside one padding bucket give the same blob length", async () => {
  const a = await createEncryptor([{ name: "a.txt", type: "text/plain", size: 5000 }]);
  const b = await createEncryptor([
    { name: "a-much-longer-file-name-than-the-other.txt", type: "text/plain", size: 5100 },
  ]);
  const c = await createEncryptor([
    { name: "one", type: "text/plain", size: 1000 },
    { name: "two", type: "text/plain", size: 2000 },
    { name: "three", type: "text/plain", size: 2100 },
  ]);
  assert.equal(a.blobLength, b.blobLength);
  assert.equal(a.blobLength, c.blobLength);
  assert.equal(a.prefix.length, c.prefix.length);
});

test("tiny files all share one blob length", async () => {
  const a = await createEncryptor([{ name: "a", type: "", size: 0 }]);
  const b = await createEncryptor([{ name: "b", type: "", size: 4000 }]);
  assert.equal(a.blobLength, b.blobLength);
});

async function tampered(edit: (blob: Uint8Array, prefixLen: number) => Uint8Array, pattern: RegExp) {
  const data = bytes(20_000);
  const { keys, blob } = await sealed([{ name: "n", type: "t", size: 20_000 }], data);
  const prefixLen = headerLength(blob.subarray(0, 5));
  await assert.rejects(decryptAll(edit(blob.slice(), prefixLen), keys), pattern);
}

test("a truncated blob fails", async () => {
  await tampered((b) => b.subarray(0, b.length - 10), /truncated/);
  await tampered((b) => b.subarray(0, b.length - (4096 + 16)), /truncated/);
});

test("trailing bytes after the final chunk fail", async () => {
  await tampered((b) => Buffer.concat([b, new Uint8Array(4096 + 16)]), /trailing/);
});

test("reordered chunks fail", async () => {
  await tampered((b, p) => {
    const c = 4096 + 16;
    const first = b.slice(p, p + c);
    b.copyWithin(p, p + c, p + 2 * c);
    b.set(first, p + c);
    return b;
  }, /chunk/);
});

test("a flipped byte in a content chunk fails", async () => {
  await tampered((b, p) => {
    b[p + 5000] ^= 1;
    return b;
  }, /chunk/);
});

test("a flipped byte in the sealed metadata fails", async () => {
  await tampered((b) => {
    b[100] ^= 1;
    return b;
  }, /header/);
});

test("a changed header length fails", async () => {
  await tampered((b) => {
    b[4] ^= 0x10;
    return b;
  }, /header/);
});

test("an unknown version byte fails", async () => {
  await tampered((b) => {
    b[0] = 0x03;
    return b;
  }, /version/);
});

test("a header from a bundle of the same link does not open single-file content", async () => {
  const files = [{ name: "n", type: "t", size: 20_000 }];
  const data = bytes(20_000);
  const single = await sealed(files, data);
  const keys = single.keys;
  const enc = buildEncryptor({
    keys,
    kind: "bundle",
    files,
    chunk: 4096,
    headerNonce: NONCE_A,
    baseNonce: new Uint8Array(24).fill(3),
  });
  const bundle = await encryptAll(enc, data);
  const p = headerLength(bundle.subarray(0, 5));
  assert.equal(p, headerLength(single.blob.subarray(0, 5)));
  const spliced = Buffer.concat([bundle.subarray(0, p), single.blob.subarray(p)]);
  await assert.rejects(decryptAll(spliced, keys), /chunk/);
});

test("a single file declared with several entries is rejected", async () => {
  const keys = await deriveKeys({ mode: "link", secret: SECRET });
  assert.throws(
    () =>
      buildEncryptor({
        keys,
        kind: "single",
        files: [
          { name: "a", type: "", size: 1 },
          { name: "b", type: "", size: 1 },
        ],
        chunk: 4096,
        headerNonce: NONCE_A,
        baseNonce: NONCE_B,
      }),
    /single/,
  );
});

test("a seek decrypts a middle chunk and fetches only that chunk", async () => {
  const size = 65536 * 5 + 123;
  const data = bytes(size);
  const enc = await createEncryptor([{ name: "v.mp4", type: "video/mp4", size }]);
  const blob = await encryptAll(enc, data);
  const keys = await openKeys(enc.token);

  const prefixLen = headerLength(blob.subarray(0, 5));
  const { header, contentOffset } = readHeader(keys, blob.subarray(0, prefixLen));
  assert.equal(contentOffset, prefixLen);

  const fetches: [number, number][] = [];
  const fetchRange = async (start: number, end: number) => {
    fetches.push([start, end]);
    return blob.subarray(start, end + 1);
  };
  const start = 65536 * 2 + 10;
  const end = 65536 * 2 + 5000;
  const got = await collect(decryptRange(keys, header, contentOffset, fetchRange, start, end));
  assert.deepEqual(got, data.subarray(start, end + 1));
  assert.deepEqual(fetches, [[contentOffset + 2 * (65536 + 16), contentOffset + 3 * (65536 + 16) - 1]]);
});

test("a seek into the last chunk stops at the real size, before the padding", async () => {
  const size = 65536 + 700;
  const data = bytes(size);
  const enc = await createEncryptor([{ name: "v", type: "", size }]);
  const blob = await encryptAll(enc, data);
  const keys = await openKeys(enc.token);
  const { header, contentOffset } = readHeader(keys, blob.subarray(0, headerLength(blob)));
  const fetchRange = async (s: number, e: number) => blob.subarray(s, e + 1);
  const got = await collect(decryptRange(keys, header, contentOffset, fetchRange, 65000, size + 5000));
  assert.deepEqual(got, data.subarray(65000));
});

test("a seek with a tampered chunk fails", async () => {
  const size = 65536 * 3;
  const enc = await createEncryptor([{ name: "v", type: "", size }]);
  const blob = await encryptAll(enc, bytes(size));
  const keys = await openKeys(enc.token);
  const { header, contentOffset } = readHeader(keys, blob.subarray(0, headerLength(blob)));
  blob[contentOffset + 65552 + 40] ^= 1;
  const fetchRange = async (s: number, e: number) => blob.subarray(s, e + 1);
  await assert.rejects(collect(decryptRange(keys, header, contentOffset, fetchRange, 65540, 65600)), /chunk/);
});

test("a share with the largest chunk decrypts from small network reads in linear time", async () => {
  const size = 16 * 1024 * 1024;
  const { keys, blob } = await sealed([{ name: "big", type: "", size }], new Uint8Array(size), { chunk: size });
  const dec = new ShareDecryptor(keys);
  let got = 0;
  const start = performance.now();
  for (let i = 0; i < blob.length; i += 4096) {
    for (const p of dec.push(blob.subarray(i, i + 4096))) got += p.length;
  }
  dec.finish();
  const ms = performance.now() - start;
  assert.equal(got, size);
  // Re-copying the pending bytes on every read takes several seconds here.
  assert.ok(ms < 1500, `decrypting took ${Math.round(ms)} ms`);
});

// Seals a hand-made header plaintext the way the encryptor does, so a header
// the encryptor would never write can be checked against the decoder.
function sealPlain(keys: ShareKeys, plain: Uint8Array): Uint8Array {
  const sealedLen = 24 + plain.length + 16;
  const out = new Uint8Array(5 + sealedLen);
  out[0] = 0x02;
  new DataView(out.buffer).setUint32(1, sealedLen);
  out.set(NONCE_A, 5);
  out.set(aeadEncrypt(plain, out.subarray(0, 5), NONCE_A, keys.header), 29);
  return out;
}

function headerPlain(json: string, opts: { jsonLen?: number; padTo?: number } = {}): Uint8Array {
  const body = new TextEncoder().encode(json);
  const plain = new Uint8Array(opts.padTo ?? paddedHeaderLength(4 + body.length));
  new DataView(plain.buffer).setUint32(0, opts.jsonLen ?? body.length);
  plain.set(body, 4);
  return plain;
}

function validHeader(): Record<string, unknown> {
  return {
    v: 2,
    kind: "single",
    mode: "link",
    kdf: null,
    chunk: 4096,
    pad: "padme",
    nonce: toBase64(NONCE_B),
    size: 10,
    files: [{ name: "a", type: "", size: 10 }],
  };
}

const linkKeys = () => deriveKeys({ mode: "link", secret: SECRET });

test("a hand-sealed valid header opens", async () => {
  const keys = await linkKeys();
  const { header } = readHeader(keys, sealPlain(keys, headerPlain(JSON.stringify(validHeader()))));
  assert.equal(header.size, 10);
});

const badHeaders: [string, (h: Record<string, unknown>) => void, RegExp][] = [
  ["a mode other than the token's", (h) => (h.mode = "link+password"), /mode/],
  ["KDF parameters in link mode", (h) => (h.kdf = { alg: "argon2id13", ...ARGON2ID }), /kdf/],
  ["an extra field", (h) => (h.extra = 1), /fields/],
  ["a missing field", (h) => delete h.pad, /fields/],
  ["a chunk size that is not a power of two", (h) => (h.chunk = 5000), /chunk/],
  ["a size that is not the sum of the files", (h) => (h.size = 11), /size/],
];
for (const [what, change, err] of badHeaders) {
  test(`a header with ${what} is rejected`, async () => {
    const keys = await linkKeys();
    const h = validHeader();
    change(h);
    assert.throws(() => readHeader(keys, sealPlain(keys, headerPlain(JSON.stringify(h)))), err);
  });
}

test("a link-and-password header must carry the token's KDF parameters", async () => {
  const keys = await deriveKeys({ mode: "link+password", secret: SECRET }, "correct horse battery");
  const h = { ...validHeader(), mode: "link+password", kdf: { alg: "argon2id13", ops: 4, mem: ARGON2ID.mem } };
  assert.throws(() => readHeader(keys, sealPlain(keys, headerPlain(JSON.stringify(h)))), /kdf/);
});

test("a header with nonzero padding is rejected", async () => {
  const keys = await linkKeys();
  const plain = headerPlain(JSON.stringify(validHeader()));
  plain[plain.length - 1] = 1;
  assert.throws(() => readHeader(keys, sealPlain(keys, plain)), /padding/);
});

test("a header padded past its bucket is rejected", async () => {
  const keys = await linkKeys();
  const plain = headerPlain(JSON.stringify(validHeader()), { padTo: 2048 });
  assert.throws(() => readHeader(keys, sealPlain(keys, plain)), /padding/);
});

test("a header whose JSON length runs past the plaintext is rejected", async () => {
  const keys = await linkKeys();
  const plain = headerPlain(JSON.stringify(validHeader()), { jsonLen: 1021 });
  assert.throws(() => readHeader(keys, sealPlain(keys, plain)), /padding/);
});

test("a header whose JSON length cuts the JSON short is rejected", async () => {
  const keys = await linkKeys();
  const json = JSON.stringify(validHeader());
  assert.throws(() => readHeader(keys, sealPlain(keys, headerPlain(json, { jsonLen: json.length - 1 }))), /padding/);
});

test("content with nonzero padding is rejected", async () => {
  const keys = await linkKeys();
  const head = sealPlain(keys, headerPlain(JSON.stringify(validHeader())));
  const plain = new Uint8Array(4096);
  plain.set(bytes(10));
  plain[4095] = 1;
  const aad = new Uint8Array(9);
  aad[8] = 1;
  const chunk = aeadEncrypt(plain, aad, deriveNonce(NONCE_B, 0), keys.content);
  await assert.rejects(decryptAll(new Uint8Array(Buffer.concat([head, chunk])), keys), /nonzero padding/);
});

test("a chunk from another blob under the same key does not open", async () => {
  const files = [{ name: "n", type: "t", size: 20_000 }];
  const data = bytes(20_000);
  const a = await sealed(files, data);
  const other = buildEncryptor({
    keys: a.keys,
    kind: "single",
    files,
    chunk: 4096,
    headerNonce: NONCE_A,
    baseNonce: new Uint8Array(24).fill(5),
  });
  const b = await encryptAll(other, data);
  const p = headerLength(a.blob.subarray(0, 5));
  const c = 4096 + 16;
  const spliced = new Uint8Array(a.blob);
  spliced.set(b.subarray(p + c, p + 2 * c), p + c);
  await assert.rejects(decryptAll(spliced, a.keys), /chunk 1/);
});

async function rangeFixture(size: number) {
  const data = bytes(size);
  const enc = await createEncryptor([{ name: "v", type: "", size }]);
  const blob = await encryptAll(enc, data);
  const keys = await openKeys(enc.token);
  const { header, contentOffset } = readHeader(keys, blob.subarray(0, headerLength(blob)));
  return { data, blob, keys, header, contentOffset };
}

test("a range decrypts from a stream of small reads of exactly its chunks", async () => {
  const { data, blob, keys, header, contentOffset } = await rangeFixture(65536 * 4 + 900);
  const start = 65536 + 7;
  const end = 65536 * 4 + 100;
  const { from, to } = cipherRange(header, contentOffset, start, end)!;

  const got = await collect(
    decryptRangeStream(keys, header, contentOffset, pieces(blob.subarray(from, to + 1), 1000), start, end),
  );

  assert.deepEqual(got, data.subarray(start, end + 1));
});

test("a range stream that ends early fails", async () => {
  const { blob, keys, header, contentOffset } = await rangeFixture(65536 * 3);
  const { from, to } = cipherRange(header, contentOffset, 0, 65536 * 3 - 1)!;
  await assert.rejects(
    collect(decryptRangeStream(keys, header, contentOffset, pieces(blob.subarray(from, to), 5000), 0, 65536 * 3 - 1)),
    /range/,
  );
});

test("a range stream with bytes past its last chunk fails", async () => {
  const { blob, keys, header, contentOffset } = await rangeFixture(65536 * 3);
  const { from, to } = cipherRange(header, contentOffset, 0, 100)!;
  await assert.rejects(
    collect(decryptRangeStream(keys, header, contentOffset, one(blob.subarray(from, to + 2)), 0, 100)),
    /range/,
  );
});
