// lib/e2e/seekable.ts
//
// The cf=2 SEEKABLE content format: per-chunk XChaCha20-Poly1305-IETF AEAD.
//
// WHY: the original content encoding (cf=1, ./crypto.ts encryptChunks) is a
// libsodium secretstream — sequential and stateful, so plaintext at byte X can
// only be produced by decrypting every frame from 0. cf=2 encrypts each 64 KiB
// chunk INDEPENDENTLY, so any chunk decrypts on its own → O(1) random access
// (real video seeking, Range-served). Zero-knowledge and the tamper guarantees
// are preserved; cf=1 blobs keep decrypting through their own path forever.
//
// CONSTRUCTION (locked; see docs/.../seekable-format-design.md):
//   - Per file: a fresh 32-byte content key K and a fresh 24-byte baseNonce.
//   - Plaintext is split into PT_CHUNK (64 KiB) chunks. Non-final chunks are
//     EXACTLY PT_CHUNK plaintext; the last chunk may be shorter and is the ONLY
//     one with finalFlag=1. An empty file is ONE final chunk of 0 plaintext.
//   - chunk i:
//       nonce_i  = baseNonce with its LAST 8 bytes XORed by the big-endian
//                  uint64 counter i (first 16 bytes unchanged) — deriveNonce().
//       aad_i    = u32be(i) (4 B) || finalFlag (1 B: 1 if last chunk, else 0).
//       cipher_i = XChaCha20-Poly1305(K, nonce_i, plaintext_i, aad_i) — i.e.
//                  ciphertext + 16-byte tag (CHUNK_TAG).
//   - The AAD binds each chunk's INDEX and FINALITY, so reordering, splicing,
//     duplicating, or truncating chunks all fail the AEAD verify. The exact
//     plaintext `size` (in enc_meta) plus the finalFlag pin the file length.
//
// NONCE UNIQUENESS (the one real AEAD hazard): a fresh K + fresh baseNonce per
// file + a monotonic counter in the low 8 bytes means no (K, nonce) pair is ever
// reused within a file, and never across files because K is fresh. XChaCha20's
// 24-byte nonce keeps a wide margin. The counter is u64; a file would need 2^64
// chunks to wrap, which is unreachable. (Tested in seekable.test.ts.)
//
// Blob layout (cf=2): [varint(metaLen)][enc_meta][chunk0][chunk1]…[chunkN].
// No separate stream header — the baseNonce lives inside enc_meta (so the server
// never sees it; it is useless without K regardless). The cipher region is just
// the chunks concatenated; chunk i is at content-offset i*(PT_CHUNK+CHUNK_TAG).

import {
  PT_CHUNK,
  aeadEncrypt,
  aeadDecrypt,
  aeadTagBytes,
} from "./crypto";

/**
 * Per-chunk AEAD tag length (16 B, XChaCha20-Poly1305). Each emitted chunk is
 * `plaintext + CHUNK_TAG`. NOTE: read at module load AFTER ready(); the value is
 * an algorithm constant so callers that import it before ready() still get the
 * libsodium constant once they've awaited ready() before any encrypt/decrypt.
 * We hardcode the known constant so the export is usable synchronously, and a
 * test asserts it equals aeadTagBytes().
 */
export const CHUNK_TAG = 16;

/** One emitted ciphertext chunk's byte length when its plaintext is full. */
const FULL_CIPHER_CHUNK = PT_CHUNK + CHUNK_TAG;

/** AAD length: u32be(index) (4) || finalFlag (1). */
const AAD_BYTES = 5;

/**
 * Derive chunk i's 24-byte nonce from the per-file `baseNonce`: the first 16
 * bytes are copied unchanged; the last 8 bytes are XORed with the big-endian
 * uint64 encoding of `i`. Pure — never mutates `baseNonce`.
 *
 * Using XOR (not add) keeps it branch-free and, with a random base nonce, gives
 * a distinct nonce for every index. i must be a non-negative safe integer.
 */
export function deriveNonce(baseNonce: Uint8Array, i: number): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0) {
    throw new Error("deriveNonce: index must be a non-negative safe integer");
  }
  const nonce = baseNonce.slice(); // copy → purity
  // Big-endian uint64 of i over the LAST 8 bytes (indices 16..23). JS bitwise is
  // 32-bit, so split i into high/low 32-bit halves via division (exact for safe
  // integers) and lay each half out big-endian.
  const low = i >>> 0; // low 32 bits
  const high = Math.floor(i / 0x1_0000_0000) >>> 0; // high 32 bits
  // High word → bytes 16..19 (big-endian).
  nonce[16] ^= (high >>> 24) & 0xff;
  nonce[17] ^= (high >>> 16) & 0xff;
  nonce[18] ^= (high >>> 8) & 0xff;
  nonce[19] ^= high & 0xff;
  // Low word → bytes 20..23 (big-endian).
  nonce[20] ^= (low >>> 24) & 0xff;
  nonce[21] ^= (low >>> 16) & 0xff;
  nonce[22] ^= (low >>> 8) & 0xff;
  nonce[23] ^= low & 0xff;
  return nonce;
}

/** Build aad_i = u32be(i) || finalFlag. */
function buildAad(i: number, isFinal: boolean): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0 || i > 0xffff_ffff) {
    // The index field is u32; cap chunk count well below any practical file.
    throw new Error("seekable: chunk index out of u32 range");
  }
  const aad = new Uint8Array(AAD_BYTES);
  aad[0] = (i >>> 24) & 0xff;
  aad[1] = (i >>> 16) & 0xff;
  aad[2] = (i >>> 8) & 0xff;
  aad[3] = i & 0xff;
  aad[4] = isFinal ? 1 : 0;
  return aad;
}

/**
 * The ciphertext byte range of FULL chunk `i` within the content region (the
 * bytes after enc_meta). Inclusive [start, end]; the final chunk may be shorter,
 * so callers clamp `end` to the cipher boundary. Pure.
 */
export function chunkByteRange(i: number): { start: number; end: number } {
  const start = i * FULL_CIPHER_CHUNK;
  return { start, end: start + FULL_CIPHER_CHUNK - 1 };
}

/**
 * Which chunk indices cover the inclusive plaintext byte range [start, end]:
 * floor(start/PT_CHUNK) .. floor(end/PT_CHUNK). Pure. Caller guarantees
 * 0 <= start <= end.
 */
export function chunksForPlaintextRange(
  start: number,
  end: number,
): { first: number; last: number } {
  return {
    first: Math.floor(start / PT_CHUNK),
    last: Math.floor(end / PT_CHUNK),
  };
}

/** Number of chunks a file of `size` plaintext bytes produces (>=1, empty = 1). */
function chunkCount(size: number): number {
  if (size <= 0) return 1; // an empty file is one final chunk of 0 bytes
  return Math.ceil(size / PT_CHUNK);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Encrypt a plaintext byte stream into the cf=2 content region: chunk0..chunkN,
 * each `aeadEncrypt(plaintext_i, aad_i, nonce_i, K)`. Non-final chunks are
 * exactly PT_CHUNK plaintext; the final chunk (the only one with finalFlag=1)
 * may be shorter, and an empty input yields exactly one final chunk of 0 bytes.
 *
 * `ready()` must have been awaited. The caller builds enc_meta (with cf=2,
 * baseNonce, size, chunkSize) and prepends it via assembleBlob.
 */
export async function* encryptSeekable(
  content: AsyncIterable<Uint8Array>,
  key: Uint8Array,
  baseNonce: Uint8Array,
): AsyncGenerator<Uint8Array> {
  let buffer: Uint8Array = new Uint8Array(0);
  let i = 0;

  for await (const part of content) {
    buffer = buffer.length === 0 ? part : concat(buffer, part);
    // Emit every FULL chunk, but keep at least one byte back so the very last
    // emitted chunk can be tagged final (a buffer of exactly PT_CHUNK is held).
    while (buffer.length > PT_CHUNK) {
      const plain = buffer.subarray(0, PT_CHUNK);
      buffer = buffer.subarray(PT_CHUNK);
      yield aeadEncrypt(plain, buildAad(i, false), deriveNonce(baseNonce, i), key);
      i++;
    }
  }
  // Flush the remainder (0..PT_CHUNK bytes) as the FINAL chunk. This ALWAYS runs
  // once — so an empty stream still emits a single final chunk of 0 plaintext
  // (the 0-byte-file single-final-chunk behavior, kept green by seekable.test.ts).
  yield aeadEncrypt(buffer, buildAad(i, true), deriveNonce(baseNonce, i), key);
}

/**
 * Re-frame an arbitrarily-chunked cipher stream into fixed-size cipher frames.
 * Yields exactly `frameLen`-byte frames except the LAST, which is whatever bytes
 * remain (0 < len <= frameLen). Throws if the stream is empty.
 */
async function* reframe(
  source: AsyncIterable<Uint8Array>,
  frameLen: number,
): AsyncGenerator<{ frame: Uint8Array; last: boolean }> {
  let buffer: Uint8Array = new Uint8Array(0);
  let pending: Uint8Array | null = null; // hold one frame back to mark `last`

  async function* flushPending(force: boolean): AsyncGenerator<{
    frame: Uint8Array;
    last: boolean;
  }> {
    // Emit complete frames from the buffer; keep exactly one frame as `pending`.
    while (buffer.length >= frameLen) {
      if (pending !== null) {
        yield { frame: pending, last: false };
      }
      pending = buffer.subarray(0, frameLen);
      buffer = buffer.subarray(frameLen);
    }
    if (force) {
      // Whatever remains in buffer is the genuine last frame (short or empty).
      if (buffer.length > 0) {
        if (pending !== null) yield { frame: pending, last: false };
        yield { frame: buffer, last: true };
        pending = null;
        buffer = new Uint8Array(0);
      } else if (pending !== null) {
        // The held frame is the final, full-length frame.
        yield { frame: pending, last: true };
        pending = null;
      }
    }
  }

  for await (const part of source) {
    buffer = buffer.length === 0 ? part : concat(buffer, part);
    yield* flushPending(false);
  }
  yield* flushPending(true);
}

/**
 * Full sequential decrypt of a cf=2 content stream. `size` is the authenticated
 * plaintext length (from enc_meta). Verifies each chunk's AAD (index + finality)
 * and the total length: a tampered/ reordered/ truncated/ extended stream, a
 * wrong key, or a wrong base nonce all throw. Yields plaintext chunks in order.
 *
 * `ready()` must have been awaited.
 */
export async function* decryptSeekable(
  cipher: AsyncIterable<Uint8Array>,
  key: Uint8Array,
  baseNonce: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  const expected = chunkCount(size);
  let i = 0;
  let producedBytes = 0;

  for await (const { frame, last } of reframe(cipher, FULL_CIPHER_CHUNK)) {
    if (i >= expected) {
      // More cipher frames than the authenticated size allows → extension.
      throw new Error("seekable: ciphertext longer than authenticated size");
    }
    const isFinal = i === expected - 1;
    // The stream's own end (`last`) must agree with the size-derived finality:
    // if they disagree the blob was truncated or extended.
    if (last !== isFinal) {
      throw new Error("seekable: ciphertext length does not match size");
    }
    let plain: Uint8Array;
    try {
      plain = aeadDecrypt(
        frame,
        buildAad(i, isFinal),
        deriveNonce(baseNonce, i),
        key,
      );
    } catch {
      // Wrong key, tampered chunk, reordered chunk (AAD index mismatch), or a
      // finality flip (AAD finalFlag mismatch) — all surface here.
      throw new Error("seekable: decryption failed");
    }
    producedBytes += plain.length;
    i++;
    yield plain;
  }

  if (i < expected) {
    throw new Error("seekable: ciphertext truncated (missing chunks)");
  }
  if (producedBytes !== size) {
    throw new Error(
      `seekable: decrypted length ${producedBytes} != authenticated size ${size}`,
    );
  }
}

/**
 * RANDOM-ACCESS decrypt: yield exactly the plaintext bytes for the inclusive
 * range [plaintextStart, plaintextEnd]. Only the ciphertext of the COVERING
 * chunks (floor(start/PT_CHUNK)..floor(end/PT_CHUNK)) is fetched and decrypted —
 * the seek path. `fetchCipherRange(cipherStart, cipherEnd)` returns the inclusive
 * ciphertext byte range from the content region (injected so it is testable
 * without network; in the browser it is an HTTP Range request against the blob's
 * content region). `size` is the authenticated plaintext length.
 *
 * Each fetched chunk is verified independently (AAD index + finality), so tamper
 * / wrong key still throw. `ready()` must have been awaited.
 */
export async function* decryptSeekableRange(
  fetchCipherRange: (cipherStart: number, cipherEnd: number) => Promise<Uint8Array>,
  key: Uint8Array,
  baseNonce: Uint8Array,
  size: number,
  plaintextStart: number,
  plaintextEnd: number,
): AsyncGenerator<Uint8Array> {
  if (size < 0) throw new Error("seekable: negative size");
  if (size === 0) return; // empty file → no plaintext bytes to yield
  // Clamp the requested range to the valid plaintext bounds.
  const start = Math.max(0, plaintextStart);
  const end = Math.min(size - 1, plaintextEnd);
  if (end < start) return;

  const total = chunkCount(size);
  const { first, last } = chunksForPlaintextRange(start, end);
  // The cipher byte span of the covering chunks. The final chunk is short, so
  // clamp the end of the fetch window to the actual cipher region size.
  const cipherRegionLen = cipherLengthForSize(size);
  const firstByte = chunkByteRange(first).start;
  const lastByteFull = chunkByteRange(last).end;
  const lastByte = Math.min(lastByteFull, cipherRegionLen - 1);
  const fetched = await fetchCipherRange(firstByte, lastByte);

  let offset = 0; // offset within `fetched`
  for (let i = first; i <= last; i++) {
    const isFinal = i === total - 1;
    // This chunk's cipher length: full unless it is the (short) final chunk.
    const thisFullEnd = chunkByteRange(i).end;
    const thisCipherEnd = Math.min(thisFullEnd, cipherRegionLen - 1);
    const thisLen = thisCipherEnd - chunkByteRange(i).start + 1;
    const frame = fetched.subarray(offset, offset + thisLen);
    offset += thisLen;

    let plain: Uint8Array;
    try {
      plain = aeadDecrypt(
        frame,
        buildAad(i, isFinal),
        deriveNonce(baseNonce, i),
        key,
      );
    } catch {
      throw new Error("seekable: decryption failed");
    }

    // Slice this chunk's plaintext to the requested window.
    const chunkPlainStart = i * PT_CHUNK; // plaintext offset of this chunk
    const from = Math.max(0, start - chunkPlainStart);
    const to = Math.min(plain.length, end + 1 - chunkPlainStart);
    if (to > from) yield plain.subarray(from, to);
  }
}

/**
 * Total length of the cf=2 content region (all chunks concatenated) for a file of
 * `size` plaintext bytes: each chunk adds CHUNK_TAG, plus the plaintext itself,
 * with an empty file being a single tag-only chunk. Pure.
 */
export function cipherLengthForSize(size: number): number {
  const n = chunkCount(size);
  return size + n * CHUNK_TAG;
}
