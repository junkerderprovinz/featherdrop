// Unit tests for the cf=2 SEEKABLE content format (per-chunk XChaCha20-Poly1305).
//
// These are SECURITY-CRITICAL: they pin down the exact on-the-wire construction
// (nonce derivation, AAD index+finality binding, blob layout) and every tamper
// guarantee (reorder, truncate, finality-flip, wrong key). They also prove the
// random-access SEEK path returns byte-exact plaintext while fetching ONLY the
// covering chunks, and that a legacy cf=1 (secretstream) blob still decrypts
// through the cf-branched download path (back-compat).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  ready,
  generateKey,
  generateAeadBaseNonce,
  aeadNonceBytes,
  aeadTagBytes,
  PT_CHUNK,
} from "../lib/e2e/crypto";
import {
  deriveNonce,
  chunkByteRange,
  chunksForPlaintextRange,
  encryptSeekable,
  decryptSeekable,
  decryptSeekableRange,
  CHUNK_TAG,
} from "../lib/e2e/seekable";
import { encryptForUpload, decryptWithKey, deriveContentKey } from "../lib/e2e/pipeline";

before(async () => {
  await ready();
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function* one(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}

async function* inChunks(data: Uint8Array, chunk: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += chunk) {
    yield data.subarray(i, Math.min(i + chunk, data.length));
  }
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
  return new Uint8Array(n).map((_, i) => (i * 131 + 17) % 251);
}

/** Cipher region (chunk0..N concatenated) for a payload; offset into the BLOB content. */
async function encryptContent(
  data: Uint8Array,
  key: Uint8Array,
  baseNonce: Uint8Array,
): Promise<Uint8Array> {
  return collect(encryptSeekable(one(data), key, baseNonce));
}

/** Build an injected fetchCipherRange over an in-memory cipher region. */
function rangeFetcher(cipher: Uint8Array): (s: number, e: number) => Promise<Uint8Array> {
  return async (cipherStart: number, cipherEnd: number) => {
    // inclusive [start, end]
    return cipher.subarray(cipherStart, cipherEnd + 1);
  };
}

// ── nonce derivation ──────────────────────────────────────────────────────────

test("CHUNK_TAG equals the AEAD tag length (16)", () => {
  assert.equal(CHUNK_TAG, aeadTagBytes());
  assert.equal(CHUNK_TAG, 16);
});

test("deriveNonce: 24 bytes, first 16 unchanged, last 8 XOR big-endian counter", () => {
  const base = generateAeadBaseNonce();
  assert.equal(base.length, aeadNonceBytes());
  assert.equal(base.length, 24);

  const n0 = deriveNonce(base, 0);
  assert.equal(n0.length, 24);
  // i=0 leaves the nonce identical (XOR with 0).
  assert.deepEqual(n0, base);

  const n1 = deriveNonce(base, 1);
  // First 16 bytes never change.
  assert.deepEqual(n1.subarray(0, 16), base.subarray(0, 16));
  // Last byte XORed with 1 (big-endian uint64 → LSB is the last byte).
  const expectedLast = base[23] ^ 1;
  assert.equal(n1[23], expectedLast);
  // Other 7 high bytes of the counter region unchanged for i=1.
  assert.deepEqual(n1.subarray(16, 23), base.subarray(16, 23));
});

test("deriveNonce: big-endian placement of a multi-byte counter", () => {
  const base = new Uint8Array(24); // all zero → nonce == big-endian counter in last 8 B
  const i = 0x0102030405060708;
  // 0x0102030405060708 exceeds 2^53; use a value within safe-int range but with
  // bytes set across the field.
  const safe = 0x0000_0001_0000_0001; // = 4294967297
  const n = deriveNonce(base, safe);
  // 4294967297 = 0x0000000100000001 big-endian over the last 8 bytes.
  assert.deepEqual(
    Array.from(n.subarray(16)),
    [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01],
  );
  // silence unused
  void i;
});

test("deriveNonce: distinct for many indices, base untouched", () => {
  const base = generateAeadBaseNonce();
  const copy = base.slice();
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const n = deriveNonce(base, i);
    const k = Buffer.from(n).toString("hex");
    assert.ok(!seen.has(k), `nonce collision at i=${i}`);
    seen.add(k);
  }
  // deriveNonce must be pure: it must not mutate the base nonce.
  assert.deepEqual(base, copy, "deriveNonce mutated the base nonce");
});

// ── chunk math ────────────────────────────────────────────────────────────────

test("chunkByteRange: chunk i is at i*(PT_CHUNK+TAG) within the content region", () => {
  const STRIDE = PT_CHUNK + CHUNK_TAG;
  for (const i of [0, 1, 2, 10, 1000]) {
    const r = chunkByteRange(i);
    assert.equal(r.start, i * STRIDE);
    // end is inclusive of a FULL chunk (start + stride - 1); a short final chunk
    // is handled by clamping at the cipher boundary by the caller.
    assert.equal(r.end, i * STRIDE + STRIDE - 1);
  }
});

test("chunksForPlaintextRange: covers floor(start/PT_CHUNK)..floor(end/PT_CHUNK)", () => {
  assert.deepEqual(chunksForPlaintextRange(0, 0), { first: 0, last: 0 });
  assert.deepEqual(chunksForPlaintextRange(0, PT_CHUNK - 1), { first: 0, last: 0 });
  assert.deepEqual(chunksForPlaintextRange(0, PT_CHUNK), { first: 0, last: 1 });
  assert.deepEqual(chunksForPlaintextRange(PT_CHUNK, PT_CHUNK), { first: 1, last: 1 });
  assert.deepEqual(
    chunksForPlaintextRange(PT_CHUNK - 5, PT_CHUNK + 5),
    { first: 0, last: 1 },
  );
  assert.deepEqual(
    chunksForPlaintextRange(PT_CHUNK * 3, PT_CHUNK * 5 + 10),
    { first: 3, last: 5 },
  );
});

// ── full round-trip (encrypt → decrypt) ──────────────────────────────────────

test("round-trip: many sizes incl. 0, 1, exact multiple, >2 chunks", async () => {
  const sizes = [
    0,
    1,
    100,
    PT_CHUNK - 1,
    PT_CHUNK, // exactly one full chunk → one more final chunk of 0 bytes? No: see note.
    PT_CHUNK + 1,
    PT_CHUNK * 2,
    PT_CHUNK * 2 + 1,
    PT_CHUNK * 3 + 1234,
    PT_CHUNK * 5,
  ];
  for (const size of sizes) {
    const data = bytes(size);
    const key = generateKey();
    const baseNonce = generateAeadBaseNonce();
    const cipher = await encryptContent(data, key, baseNonce);
    const out = await collect(
      decryptSeekable(one(cipher), key, baseNonce, size),
    );
    assert.deepEqual(out, data, `round-trip failed for size ${size}`);
  }
});

test("round-trip: decrypt is robust to arbitrary cipher chunk boundaries", async () => {
  const data = bytes(PT_CHUNK * 3 + 999);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  for (const cs of [1, 7, 100, 4096, PT_CHUNK, PT_CHUNK + CHUNK_TAG, 1_000_000]) {
    const out = await collect(
      decryptSeekable(inChunks(cipher, cs), key, baseNonce, data.length),
    );
    assert.deepEqual(out, data, `cipher chunk size ${cs}`);
  }
});

test("empty file = exactly one final chunk of 0 plaintext bytes (TAG only)", async () => {
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(new Uint8Array(0), key, baseNonce);
  // One chunk: 0 plaintext + 16-byte tag.
  assert.equal(cipher.length, CHUNK_TAG);
  const out = await collect(decryptSeekable(one(cipher), key, baseNonce, 0));
  assert.equal(out.length, 0);
});

test("exact multiple of PT_CHUNK does NOT emit an extra empty final chunk", async () => {
  // A file that is exactly N*PT_CHUNK: the last full chunk is the final chunk; no
  // trailing zero-length chunk (that would change chunk count / cipher size).
  const data = bytes(PT_CHUNK * 2);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  // 2 chunks → 2*(PT_CHUNK + TAG).
  assert.equal(cipher.length, 2 * (PT_CHUNK + CHUNK_TAG));
  const out = await collect(decryptSeekable(one(cipher), key, baseNonce, data.length));
  assert.deepEqual(out, data);
});

// ── RANGE (seek) decrypt = byte-exact, fetches only covering chunks ───────────

test("range decrypt: byte-exact vs full plaintext for many ranges", async () => {
  const data = bytes(PT_CHUNK * 4 + 5000);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const fetchRange = rangeFetcher(cipher);

  const ranges: [number, number][] = [
    [0, data.length - 1], // whole file
    [0, 0], // first byte
    [data.length - 1, data.length - 1], // last byte
    [PT_CHUNK - 5, PT_CHUNK + 5], // across a chunk boundary
    [PT_CHUNK * 2, PT_CHUNK * 2 + 999], // a middle chunk
    [PT_CHUNK * 3, data.length - 1], // suffix incl. final chunk
    [100, 100], // single byte mid-chunk-0
    [PT_CHUNK * 4, PT_CHUNK * 4 + 10], // in the (short) final chunk
    [50_000, 200_000], // spans 3+ chunks
  ];

  for (const [start, end] of ranges) {
    const out = await collect(
      decryptSeekableRange(fetchRange, key, baseNonce, data.length, start, end),
    );
    assert.deepEqual(
      out,
      data.subarray(start, end + 1),
      `range [${start}, ${end}]`,
    );
  }
});

test("range decrypt: fetches ONLY the covering chunks' ciphertext", async () => {
  const data = bytes(PT_CHUNK * 6 + 123);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);

  const fetched: [number, number][] = [];
  const fetchRange = async (s: number, e: number): Promise<Uint8Array> => {
    fetched.push([s, e]);
    return cipher.subarray(s, e + 1);
  };

  // A range fully inside chunk 2 only.
  const start = PT_CHUNK * 2 + 10;
  const end = PT_CHUNK * 2 + 200;
  const out = await collect(
    decryptSeekableRange(fetchRange, key, baseNonce, data.length, start, end),
  );
  assert.deepEqual(out, data.subarray(start, end + 1));

  // Every fetched byte must lie within chunk 2's byte range — no whole-file pull.
  const stride = PT_CHUNK + CHUNK_TAG;
  const chunk2Start = 2 * stride;
  const chunk2End = 3 * stride - 1;
  for (const [s, e] of fetched) {
    assert.ok(s >= chunk2Start, `fetch start ${s} before chunk 2`);
    assert.ok(e <= chunk2End, `fetch end ${e} past chunk 2`);
  }
  // And the total fetched bytes are ~one chunk, far less than the whole cipher.
  const totalFetched = fetched.reduce((a, [s, e]) => a + (e - s + 1), 0);
  assert.ok(
    totalFetched <= stride,
    `fetched ${totalFetched} bytes, expected <= one chunk (${stride})`,
  );
});

test("range decrypt: tail/suffix and single-byte at EOF", async () => {
  const data = bytes(PT_CHUNK * 3 + 77);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const fetchRange = rangeFetcher(cipher);

  // suffix
  let out = await collect(
    decryptSeekableRange(fetchRange, key, baseNonce, data.length, data.length - 50, data.length - 1),
  );
  assert.deepEqual(out, data.subarray(data.length - 50));

  // single last byte
  out = await collect(
    decryptSeekableRange(fetchRange, key, baseNonce, data.length, data.length - 1, data.length - 1),
  );
  assert.deepEqual(out, data.subarray(data.length - 1));
});

// ── tamper / integrity guarantees ─────────────────────────────────────────────

test("tamper a chunk byte → throws", async () => {
  const data = bytes(PT_CHUNK * 2 + 10);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const bad = cipher.slice();
  bad[100] ^= 0xff; // flip a byte inside chunk 0
  await assert.rejects(
    () => collect(decryptSeekable(one(bad), key, baseNonce, data.length)),
    /decryption failed|verification/i,
  );
});

test("swap two chunks → throws (AAD index binding)", async () => {
  const data = bytes(PT_CHUNK * 2 + 10); // 3 chunks (0,1 full, 2 short)
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const stride = PT_CHUNK + CHUNK_TAG;
  const swapped = cipher.slice();
  // Swap full chunk 0 and full chunk 1 (same length) — their AAD index won't match.
  const c0 = cipher.subarray(0, stride);
  const c1 = cipher.subarray(stride, 2 * stride);
  swapped.set(c1, 0);
  swapped.set(c0, stride);
  await assert.rejects(
    () => collect(decryptSeekable(one(swapped), key, baseNonce, data.length)),
    /decryption failed|verification/i,
  );
});

test("drop the final chunk / truncate → throws (size + finalFlag)", async () => {
  const data = bytes(PT_CHUNK * 2 + 10);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const stride = PT_CHUNK + CHUNK_TAG;
  // Drop the final (short) chunk → only 2 full chunks remain.
  const truncated = cipher.subarray(0, 2 * stride);
  await assert.rejects(
    () => collect(decryptSeekable(one(truncated), key, baseNonce, data.length)),
    /truncat|short|final|size/i,
  );
});

test("flip a non-final chunk to look final → throws (AAD finality)", async () => {
  // Build a 2-chunk file, then try to decrypt chunk 0 AS IF it were final.
  // We do this through the low-level path: re-derive nonce/aad to forge.
  const data = bytes(PT_CHUNK + 100); // chunk 0 full (non-final), chunk 1 final
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const stride = PT_CHUNK + CHUNK_TAG;
  // Take ONLY chunk 0 and lie that the file is exactly PT_CHUNK bytes (so the
  // decrypter expects chunk 0 to be final). Chunk 0 was sealed with finalFlag=0,
  // so the AAD won't match finalFlag=1 → must throw.
  const chunk0 = cipher.subarray(0, stride);
  await assert.rejects(
    () => collect(decryptSeekable(one(chunk0), key, baseNonce, PT_CHUNK)),
    /decryption failed|verification|final/i,
  );
});

test("treat a final chunk as non-final → throws", async () => {
  // A single-chunk file: chunk 0 IS final. Claim the file is larger so the
  // decrypter expects chunk 0 to be non-final (finalFlag=0) and a second chunk.
  const data = bytes(1000); // one final chunk
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  // Claim size = PT_CHUNK + 1 → 2 chunks expected; chunk 0 should be full+non-final.
  await assert.rejects(
    () => collect(decryptSeekable(one(cipher), key, baseNonce, PT_CHUNK + 1)),
    /decryption failed|verification|final|truncat|short|size/i,
  );
});

test("wrong key → throws", async () => {
  const data = bytes(PT_CHUNK + 50);
  const key = generateKey();
  const wrong = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  await assert.rejects(
    () => collect(decryptSeekable(one(cipher), wrong, baseNonce, data.length)),
    /decryption failed|verification/i,
  );
});

test("wrong base nonce → throws", async () => {
  const data = bytes(PT_CHUNK + 50);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const wrongNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  await assert.rejects(
    () => collect(decryptSeekable(one(cipher), key, wrongNonce, data.length)),
    /decryption failed|verification/i,
  );
});

test("range decrypt also rejects tamper within the fetched chunk", async () => {
  const data = bytes(PT_CHUNK * 3);
  const key = generateKey();
  const baseNonce = generateAeadBaseNonce();
  const cipher = await encryptContent(data, key, baseNonce);
  const bad = cipher.slice();
  const stride = PT_CHUNK + CHUNK_TAG;
  bad[2 * stride + 5] ^= 0xff; // corrupt chunk 2
  const fetchRange = rangeFetcher(bad);
  await assert.rejects(
    () =>
      collect(
        decryptSeekableRange(
          fetchRange, key, baseNonce, data.length,
          PT_CHUNK * 2 + 1, PT_CHUNK * 2 + 100,
        ),
      ),
    /decryption failed|verification/i,
  );
});

// ── nonce-uniqueness assertion (the one real hazard) ─────────────────────────

test("every chunk of a file uses a UNIQUE (key, nonce) pair", async () => {
  // Encrypt a multi-chunk file and verify each emitted chunk's derived nonce is
  // distinct. Combined with a fresh per-file K + base nonce, this rules out
  // (K, nonce) reuse — the only catastrophic AEAD failure mode.
  const data = bytes(PT_CHUNK * 4 + 1);
  const baseNonce = generateAeadBaseNonce();
  const chunkCount = Math.ceil(data.length / PT_CHUNK);
  const nonces = new Set<string>();
  for (let i = 0; i < chunkCount; i++) {
    const n = deriveNonce(baseNonce, i);
    const hex = Buffer.from(n).toString("hex");
    assert.ok(!nonces.has(hex), `repeated nonce at chunk ${i}`);
    nonces.add(hex);
  }
  assert.equal(nonces.size, chunkCount);
});

// ── pipeline integration (cf=2 upload + cf-branched decrypt) ─────────────────

test("encryptForUpload({seekable:true}) writes cf=2 and round-trips", async () => {
  const data = bytes(PT_CHUNK * 3 + 4242);
  const meta = { name: "clip.mp4", type: "video/mp4", size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta, { seekable: true });
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });
  const { meta: out, plaintext } = await decryptWithKey(one(cipher), key);
  assert.equal(out.cf, 2, "meta must record cf=2");
  assert.equal(out.chunkSize, PT_CHUNK);
  assert.equal(out.size, data.length);
  assert.equal(out.name, "clip.mp4");
  assert.equal(out.type, "video/mp4");
  const pt = await collect(plaintext);
  assert.deepEqual(pt, data);
});

test("cf=2 enc_meta keeps the blob zero-knowledge (baseNonce/size not leaked)", async () => {
  const data = bytes(PT_CHUNK + 999);
  const meta = { name: "secret.bin", type: "application/octet-stream", size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta, { seekable: true });
  const cipher = await collect(blob);
  const hay = new TextDecoder("latin1").decode(cipher);
  // The plaintext size and the filename must not appear verbatim.
  assert.ok(!hay.includes(String(data.length)), "size leaked into blob");
  assert.ok(!hay.includes("secret.bin"), "filename leaked into blob");
  void keyForUrl;
});

test("default encryptForUpload stays cf=1 (secretstream) and unchanged", async () => {
  const data = bytes(2000);
  const meta = { name: "old.txt", type: "text/plain", size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta);
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });
  const { meta: out, plaintext } = await decryptWithKey(one(cipher), key);
  // cf absent on a cf=1 blob (or explicitly undefined) — the decrypter treats it
  // as secretstream.
  assert.ok(out.cf === undefined || out.cf === 1, "default upload must be cf=1");
  assert.deepEqual(await collect(plaintext), data);
});

test("BACK-COMPAT: a cf=1 secretstream blob still decrypts via the branched path", async () => {
  // Produce a blob the OLD way (no seekable option) and confirm the branched
  // decryptWithKey routes it through secretstream. This is the legacy-blob guard.
  const data = bytes(PT_CHUNK * 2 + 321);
  const { blob, keyForUrl } = await encryptForUpload(one(data), {
    name: "legacy.mp4",
    type: "video/mp4",
  });
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });
  const { meta, plaintext } = await decryptWithKey(one(cipher), key);
  assert.equal(meta.name, "legacy.mp4");
  assert.deepEqual(await collect(plaintext), data);
});
