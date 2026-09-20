// The seekable content format (cf=2): per-chunk XChaCha20-Poly1305-IETF AEAD.
//
// The secretstream of cf=1 is sequential, so reaching byte X means decrypting
// every frame before it. cf=2 encrypts each 64 KiB chunk on its own, which lets
// a video preview seek with Range requests.
//
// Format:
//   - Each file has a fresh 32-byte key K and a fresh 24-byte baseNonce.
//   - Plaintext is split into PT_CHUNK chunks. Only the last may be shorter,
//     and only the last has finalFlag=1. An empty file is one final empty chunk.
//   - nonce_i  = baseNonce with its last 8 bytes XORed by the big-endian u64 i.
//   - aad_i    = u32be(i) || finalFlag.
//   - cipher_i = XChaCha20-Poly1305(K, nonce_i, plaintext_i, aad_i), which is
//     the plaintext plus a 16-byte tag.
//
// The AAD binds each chunk's index and finality, so reordering, splicing,
// duplicating or truncating chunks fails verification, and the plaintext size
// in enc_meta pins the length. A fresh K per file and a counter in the nonce
// mean no (K, nonce) pair is ever reused.
//
// The content region is the chunks concatenated, with chunk i at offset
// i*(PT_CHUNK+CHUNK_TAG). The baseNonce lives in enc_meta, so there is no
// stream header.

import {
  PT_CHUNK,
  aeadEncrypt,
  aeadDecrypt,
  aeadTagBytes,
} from "./crypto";

/**
 * AEAD tag length per chunk. It is a constant so it is usable before ready();
 * a test checks it against aeadTagBytes().
 */
export const CHUNK_TAG = 16;

const FULL_CIPHER_CHUNK = PT_CHUNK + CHUNK_TAG;

const AAD_BYTES = 5;

/**
 * Derives chunk i's nonce: baseNonce with its last 8 bytes XORed by the
 * big-endian u64 of i. With a random base this gives a distinct nonce per index.
 */
export function deriveNonce(baseNonce: Uint8Array, i: number): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0) {
    throw new Error("deriveNonce: index must be a non-negative safe integer");
  }
  const nonce = baseNonce.slice();
  // JS bitwise operators are 32-bit, so i is split into two 32-bit words.
  const low = i >>> 0;
  const high = Math.floor(i / 0x1_0000_0000) >>> 0;
  nonce[16] ^= (high >>> 24) & 0xff;
  nonce[17] ^= (high >>> 16) & 0xff;
  nonce[18] ^= (high >>> 8) & 0xff;
  nonce[19] ^= high & 0xff;
  nonce[20] ^= (low >>> 24) & 0xff;
  nonce[21] ^= (low >>> 16) & 0xff;
  nonce[22] ^= (low >>> 8) & 0xff;
  nonce[23] ^= low & 0xff;
  return nonce;
}

function buildAad(i: number, isFinal: boolean): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0 || i > 0xffff_ffff) {
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
 * The inclusive cipher byte range of a full chunk i within the content region.
 * The final chunk may be shorter, so callers clamp the end.
 */
export function chunkByteRange(i: number): { start: number; end: number } {
  const start = i * FULL_CIPHER_CHUNK;
  return { start, end: start + FULL_CIPHER_CHUNK - 1 };
}

/** The chunk indices covering the inclusive plaintext range [start, end]. */
export function chunksForPlaintextRange(
  start: number,
  end: number,
): { first: number; last: number } {
  return {
    first: Math.floor(start / PT_CHUNK),
    last: Math.floor(end / PT_CHUNK),
  };
}

function chunkCount(size: number): number {
  if (size <= 0) return 1;
  return Math.ceil(size / PT_CHUNK);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Encrypts a plaintext stream into the cf=2 content region. The caller builds
 * enc_meta and prepends it with assembleBlob. ready() must have been awaited.
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
    // Something always stays behind so the last chunk can be marked final.
    while (buffer.length > PT_CHUNK) {
      const plain = buffer.subarray(0, PT_CHUNK);
      buffer = buffer.subarray(PT_CHUNK);
      yield aeadEncrypt(plain, buildAad(i, false), deriveNonce(baseNonce, i), key);
      i++;
    }
  }
  // Runs even for an empty stream, which yields one final empty chunk.
  yield aeadEncrypt(buffer, buildAad(i, true), deriveNonce(baseNonce, i), key);
}

/**
 * Re-frames an arbitrarily chunked stream into frames of frameLen bytes. Only
 * the last frame may be shorter.
 */
async function* reframe(
  source: AsyncIterable<Uint8Array>,
  frameLen: number,
): AsyncGenerator<{ frame: Uint8Array; last: boolean }> {
  let buffer: Uint8Array = new Uint8Array(0);
  // One frame is held back until it is known whether it is the last.
  let pending: Uint8Array | null = null;

  async function* flushPending(force: boolean): AsyncGenerator<{
    frame: Uint8Array;
    last: boolean;
  }> {
    while (buffer.length >= frameLen) {
      if (pending !== null) {
        yield { frame: pending, last: false };
      }
      pending = buffer.subarray(0, frameLen);
      buffer = buffer.subarray(frameLen);
    }
    if (force) {
      if (buffer.length > 0) {
        if (pending !== null) yield { frame: pending, last: false };
        yield { frame: buffer, last: true };
        pending = null;
        buffer = new Uint8Array(0);
      } else if (pending !== null) {
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
 * Decrypts a whole cf=2 content stream in order. size is the authenticated
 * plaintext length from enc_meta. A tampered, reordered, truncated or extended
 * stream, a wrong key and a wrong base nonce all throw. ready() must have been
 * awaited.
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
      throw new Error("seekable: ciphertext longer than authenticated size");
    }
    const isFinal = i === expected - 1;
    // Where the stream ends has to agree with the finality the size implies.
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
 * Yields the plaintext of the inclusive range [plaintextStart, plaintextEnd],
 * fetching and decrypting only the chunks that cover it. fetchCipherRange
 * returns an inclusive byte range of the content region; in the browser it is
 * an HTTP Range request. Every chunk is verified on its own, so tampering and a
 * wrong key still throw. ready() must have been awaited.
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
  if (size === 0) return;
  const start = Math.max(0, plaintextStart);
  const end = Math.min(size - 1, plaintextEnd);
  if (end < start) return;

  const total = chunkCount(size);
  const { first, last } = chunksForPlaintextRange(start, end);
  // The final chunk is short, so the fetch window ends at the region's end.
  const cipherRegionLen = cipherLengthForSize(size);
  const firstByte = chunkByteRange(first).start;
  const lastByteFull = chunkByteRange(last).end;
  const lastByte = Math.min(lastByteFull, cipherRegionLen - 1);
  const fetched = await fetchCipherRange(firstByte, lastByte);

  let offset = 0;
  for (let i = first; i <= last; i++) {
    const isFinal = i === total - 1;
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

    const chunkPlainStart = i * PT_CHUNK;
    const from = Math.max(0, start - chunkPlainStart);
    const to = Math.min(plain.length, end + 1 - chunkPlainStart);
    if (to > from) yield plain.subarray(from, to);
  }
}

/** Length of the cf=2 content region for size plaintext bytes. */
export function cipherLengthForSize(size: number): number {
  const n = chunkCount(size);
  return size + n * CHUNK_TAG;
}
