// Unit tests for the streaming large-video preview's range-slicing core.
//
// The browser plumbing (service worker, MessagePort, <video>) can only be
// exercised in a real browser/CI. What IS pure and load-bearing is sliceRange():
// given the SEQUENTIAL decrypted plaintext stream, it must hand back EXACTLY the
// bytes for an inclusive [start, end] byte range, without buffering. These tests
// drive it through the REAL zero-knowledge encrypt → decrypt pipeline so a
// regression in either the crypto framing or the slice math is caught.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, PT_CHUNK, fromBase64 } from "../lib/e2e/crypto";
import { encryptForUpload, decryptWithKey } from "../lib/e2e/pipeline";
import { deriveContentKey } from "../lib/e2e/pipeline";
import { sliceRange, cipherPrefixEnd, seekCipherByteRange } from "../lib/e2e/stream-preview";
import { peekBlobHeader } from "../lib/e2e/blob-layout";
import {
  cipherLengthForSize,
  chunkByteRange,
  chunksForPlaintextRange,
  decryptSeekableRange,
} from "../lib/e2e/seekable";

before(async () => {
  await ready();
});

async function* one(b: Uint8Array) {
  yield b;
}

// Re-chunk a byte array into many small async chunks so sliceRange has to handle
// arbitrary chunk boundaries (the real decrypt stream emits PT_CHUNK-sized frames,
// but the slice math must not depend on any particular chunking).
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
  return new Uint8Array(n).map((_, i) => (i * 31 + 7) % 251);
}

const META = { name: "clip.mp4", type: "video/mp4" };

// ── sliceRange over a plain (already-plaintext) source ──────────────────────

test("sliceRange returns the whole file for [0, size-1]", async () => {
  const data = bytes(10_000);
  const out = await collect(sliceRange(inChunks(data, 333), 0, data.length - 1));
  assert.deepEqual(out, data);
});

test("sliceRange extracts a middle window byte-exactly", async () => {
  const data = bytes(10_000);
  const start = 2500;
  const end = 7777; // inclusive
  const out = await collect(sliceRange(inChunks(data, 333), start, end));
  assert.deepEqual(out, data.subarray(start, end + 1));
  assert.equal(out.length, end - start + 1);
});

test("sliceRange handles a 1-byte range", async () => {
  const data = bytes(5000);
  const out = await collect(sliceRange(inChunks(data, 64), 1234, 1234));
  assert.equal(out.length, 1);
  assert.equal(out[0], data[1234]);
});

test("sliceRange handles a suffix range (tail of the file)", async () => {
  const data = bytes(5000);
  const start = 4990;
  const end = 4999;
  const out = await collect(sliceRange(inChunks(data, 100), start, end));
  assert.deepEqual(out, data.subarray(start, end + 1));
});

test("sliceRange is robust to chunk boundaries straddling start/end", async () => {
  const data = bytes(8192);
  // Many different chunk sizes — the window must come out identical each time.
  for (const cs of [1, 7, 64, 100, 999, 4096, 8192]) {
    const start = 1000;
    const end = 6000;
    const out = await collect(sliceRange(inChunks(data, cs), start, end));
    assert.deepEqual(out, data.subarray(start, end + 1), `chunk size ${cs}`);
  }
});

test("sliceRange stops early and does not over-read the source", async () => {
  const data = bytes(10_000);
  let pulled = 0;
  async function* counting(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < data.length; i += 100) {
      pulled += 1;
      yield data.subarray(i, Math.min(i + 100, data.length));
    }
  }
  // Want only the first 250 bytes — should stop after ~3 chunks, not drain all 100.
  const out = await collect(sliceRange(counting(), 0, 249));
  assert.deepEqual(out, data.subarray(0, 250));
  assert.ok(pulled <= 4, `expected an early stop, but pulled ${pulled} chunks`);
});

// ── sliceRange over the REAL decrypted zero-knowledge stream ────────────────

test("sliceRange over a real decrypted video stream yields exact range bytes", async () => {
  // A payload spanning several 64 KiB secretstream frames.
  const data = bytes(PT_CHUNK * 3 + 1234);
  const { blob, keyForUrl } = await encryptForUpload(one(data), META);
  const cipher = await collect(blob);

  const key = await deriveContentKey({ keyFromUrl: keyForUrl });

  // Several ranges, including ones crossing frame boundaries and the final frame.
  const ranges: [number, number][] = [
    [0, data.length - 1], // whole file
    [0, 0], // first byte
    [PT_CHUNK - 5, PT_CHUNK + 5], // across a frame boundary
    [PT_CHUNK * 2, PT_CHUNK * 2 + 999], // a later frame
    [data.length - 10, data.length - 1], // tail (final frame)
  ];

  for (const [start, end] of ranges) {
    // Each range re-decrypts from 0 (the accepted sequential-cipher limitation).
    const { plaintext } = await decryptWithKey(one(cipher), key);
    const out = await collect(sliceRange(plaintext, start, end));
    assert.deepEqual(
      out,
      data.subarray(start, end + 1),
      `range [${start}, ${end}]`,
    );
  }
});

test("concatenating sequential ranges reconstructs the whole file", async () => {
  // Simulate a player pulling the file in successive Range requests.
  const data = bytes(PT_CHUNK * 2 + 4096);
  const { blob, keyForUrl } = await encryptForUpload(one(data), META);
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });

  const windows: [number, number][] = [];
  const step = 50_000;
  for (let s = 0; s < data.length; s += step) {
    windows.push([s, Math.min(s + step - 1, data.length - 1)]);
  }

  const pieces: Uint8Array[] = [];
  for (const [start, end] of windows) {
    const { plaintext } = await decryptWithKey(one(cipher), key);
    pieces.push(await collect(sliceRange(plaintext, start, end)));
  }
  const total = new Uint8Array(data.length);
  let off = 0;
  for (const p of pieces) {
    total.set(p, off);
    off += p.length;
  }
  assert.deepEqual(total, data);
});

// ── C1: plaintext size embedded in the encrypted FileMeta round-trips ────────

test("FileMeta.size (plaintext length) round-trips through encrypt → decrypt", async () => {
  const data = bytes(PT_CHUNK + 4242);
  const meta = { name: "clip.mp4", type: "video/mp4", size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta);
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });
  const { meta: out } = await decryptWithKey(one(cipher), key);
  assert.equal(out.name, "clip.mp4");
  assert.equal(out.type, "video/mp4");
  assert.equal(out.size, data.length, "plaintext size must survive the round trip");
  // And it stays INSIDE the ciphertext (zero-knowledge): the number must not be
  // recoverable from the opaque blob bytes. (A loose check: the little-endian /
  // ASCII forms of the size should not appear verbatim in the ciphertext.)
  const hay = new TextDecoder("latin1").decode(cipher);
  assert.ok(!hay.includes(String(data.length)), "plaintext size leaked into blob");
});

test("FileMeta without size still decrypts (older shares omit it)", async () => {
  const data = bytes(2000);
  const { blob, keyForUrl } = await encryptForUpload(one(data), {
    name: "old.mp4",
    type: "video/mp4",
  });
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });
  const { meta } = await decryptWithKey(one(cipher), key);
  assert.equal(meta.size, undefined, "absent size must stay undefined (fallback path)");
});

// ── M3: ciphertext-prefix bound for the per-range fetch ─────────────────────

test("cipherPrefixEnd: a near-start range fetches only a small prefix", () => {
  const plaintextSize = 200 * 1024 * 1024; // 200 MB video
  const ciphertextSize = plaintextSize + 60_000; // ~crypto overhead
  // Want plaintext [0, 1000] — frame 0 only.
  const end = cipherPrefixEnd(1000, plaintextSize, ciphertextSize);
  assert.notEqual(end, null, "a non-tail range must use a bounded prefix");
  // The bound must cover at least frame 0's ciphertext, and be far below the file.
  assert.ok((end as number) >= PT_CHUNK, "must cover at least the first frame");
  assert.ok(
    (end as number) < ciphertextSize / 2,
    "a near-start range must not fetch most of the file",
  );
});

test("cipherPrefixEnd: a tail range returns null (fetch through EOF for TAG_FINAL)", () => {
  const plaintextSize = 200 * 1024 * 1024;
  const ciphertextSize = plaintextSize + 60_000;
  // A range in the LAST plaintext frame must fetch the whole ciphertext so the
  // final TAG_FINAL frame is present.
  const end = cipherPrefixEnd(plaintextSize - 1, plaintextSize, ciphertextSize);
  assert.equal(end, null, "tail range must fetch through EOF");
});

test("cipherPrefixEnd: a mid-file range grows monotonically with offset", () => {
  const plaintextSize = 500 * 1024 * 1024;
  const ciphertextSize = plaintextSize + 200_000;
  const a = cipherPrefixEnd(PT_CHUNK * 10, plaintextSize, ciphertextSize);
  const b = cipherPrefixEnd(PT_CHUNK * 100, plaintextSize, ciphertextSize);
  assert.ok(a !== null && b !== null);
  assert.ok((b as number) > (a as number), "later offset must need a longer prefix");
});

// The prefix bound must be CORRECT: fetching exactly cipherPrefixEnd ciphertext
// bytes and decrypting must yield at least through the requested plaintext `end`.
test("cipherPrefixEnd prefix is sufficient to decrypt the requested range", async () => {
  // A multi-frame payload; request a non-tail range and decrypt only the prefix.
  const data = bytes(PT_CHUNK * 8 + 777);
  const meta = { name: "v.mp4", type: "video/mp4", size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta);
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });

  const start = PT_CHUNK * 2;
  const end = PT_CHUNK * 3 + 100; // safely NOT in the last frame
  const cEnd = cipherPrefixEnd(end, data.length, cipher.length);
  assert.notEqual(cEnd, null, "this mid-file range should use a bounded prefix");
  // Slice the ciphertext to the computed prefix and decrypt only that.
  const prefix = cipher.subarray(0, (cEnd as number) + 1);
  const { plaintext } = await decryptWithKey(one(prefix), key);
  const out = await collect(sliceRange(plaintext, start, end));
  assert.deepEqual(
    out,
    data.subarray(start, end + 1),
    "the bounded prefix must decode the full requested range",
  );
});

// ── cf=2 SEEKABLE preview: plaintext→absolute-ciphertext byte mapping ─────────

const VIDEO_META = { name: "clip.mp4", type: "video/mp4" };

test("seekCipherByteRange maps plaintext→absolute blob bytes (offset + chunk math)", () => {
  const size = PT_CHUNK * 5 + 1234;
  const contentOffset = 137; // arbitrary [varint(metaLen)][enc_meta] length
  const cipherLen = cipherLengthForSize(size);

  // A range fully inside chunk 2 → only chunk 2's cipher bytes, shifted by offset.
  const r = seekCipherByteRange(PT_CHUNK * 2 + 10, PT_CHUNK * 2 + 50, size, contentOffset);
  assert.ok(r);
  const { first, last } = chunksForPlaintextRange(PT_CHUNK * 2 + 10, PT_CHUNK * 2 + 50);
  assert.equal(first, 2);
  assert.equal(last, 2);
  assert.equal(r!.start, contentOffset + chunkByteRange(2).start);
  assert.equal(r!.end, contentOffset + chunkByteRange(2).end);

  // A tail range is clamped to the (short) final chunk's real end, never past EOF.
  const tail = seekCipherByteRange(size - 5, size - 1, size, contentOffset);
  assert.ok(tail);
  assert.equal(tail!.end, contentOffset + cipherLen - 1, "tail clamps to cipher EOF");

  // Empty / inverted ranges fetch nothing.
  assert.equal(seekCipherByteRange(0, -1, size, contentOffset), null);
  assert.equal(seekCipherByteRange(0, 0, 0, contentOffset), null);
});

// The full cf=2 preview pipe, minus the network: take a cf=2 blob, learn its
// content offset from the header, and prove that decrypting ONLY the covering
// chunks' bytes (as the SW factory would Range-fetch them) yields exact plaintext
// AND that the fetched span lies within the covering chunks (not the whole file).
test("cf=2 preview: a covering-chunk fetch yields exact plaintext, fetching only those bytes", async () => {
  const data = bytes(PT_CHUNK * 6 + 777);
  const meta = { ...VIDEO_META, size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta, {
    seekable: true,
  });
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });

  // The download mount reads the header from a prefix to get the content offset.
  const { contentOffset } = peekBlobHeader(cipher);
  const { meta: dec } = await decryptWithKey(one(cipher), key);
  assert.equal(dec.cf, 2);
  const baseNonce = fromBase64(dec.baseNonce!);
  const size = dec.size!;

  // Record every ABSOLUTE byte span the factory would Range-fetch. The injected
  // fetch is given CONTENT-relative spans; we translate via contentOffset exactly
  // like makeFormat2SeekRangeFactory does in the browser.
  const absoluteFetched: [number, number][] = [];
  const fetchCipherRange = async (cStart: number, cEnd: number): Promise<Uint8Array> => {
    absoluteFetched.push([contentOffset + cStart, contentOffset + cEnd]);
    return cipher.subarray(contentOffset + cStart, contentOffset + cEnd + 1);
  };

  // A range living entirely in chunk 3.
  const start = PT_CHUNK * 3 + 100;
  const end = PT_CHUNK * 3 + 4000;
  const out = await collect(
    decryptSeekableRange(fetchCipherRange, key, baseNonce, size, start, end),
  );
  assert.deepEqual(out, data.subarray(start, end + 1), "exact plaintext for the range");

  // Only chunk 3's bytes were fetched — and they map to absolute blob offsets via
  // contentOffset. Assert the fetched ciphertext span is exactly chunk 3's.
  const expected = seekCipherByteRange(start, end, size, contentOffset);
  assert.ok(expected);
  assert.equal(absoluteFetched.length, 1, "one covering fetch");
  assert.equal(absoluteFetched[0][0], expected!.start);
  assert.equal(absoluteFetched[0][1], expected!.end);
  const fetchedLen = absoluteFetched[0][1] - absoluteFetched[0][0] + 1;
  assert.ok(
    fetchedLen <= PT_CHUNK + 64,
    `fetched ${fetchedLen} bytes, expected ~one chunk, not the whole file`,
  );
});

test("cf=2 preview: sequential covering-chunk ranges reconstruct the whole video", async () => {
  const data = bytes(PT_CHUNK * 4 + 5000);
  const meta = { ...VIDEO_META, size: data.length };
  const { blob, keyForUrl } = await encryptForUpload(one(data), meta, {
    seekable: true,
  });
  const cipher = await collect(blob);
  const key = await deriveContentKey({ keyFromUrl: keyForUrl });
  const { contentOffset } = peekBlobHeader(cipher);
  const { meta: dec } = await decryptWithKey(one(cipher), key);
  const baseNonce = fromBase64(dec.baseNonce!);
  const size = dec.size!;

  const fetchCipherRange = async (cStart: number, cEnd: number): Promise<Uint8Array> =>
    cipher.subarray(contentOffset + cStart, contentOffset + cEnd + 1);

  const pieces: Uint8Array[] = [];
  const step = 70_000;
  for (let s = 0; s < data.length; s += step) {
    const e = Math.min(s + step - 1, data.length - 1);
    pieces.push(
      await collect(decryptSeekableRange(fetchCipherRange, key, baseNonce, size, s, e)),
    );
  }
  const total = new Uint8Array(data.length);
  let off = 0;
  for (const p of pieces) {
    total.set(p, off);
    off += p.length;
  }
  assert.deepEqual(total, data);
});
