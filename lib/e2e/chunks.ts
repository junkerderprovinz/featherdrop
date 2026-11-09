// Chunk sizes and offsets of the format 2 and 3 content (see ./seekable.ts).
// The page plans range reads with them; the crypto worker does the AEAD.

/** Plaintext chunk size for streaming content encryption. */
export const PT_CHUNK = 65536;

/** AEAD tag length per seekable chunk; a test checks it against libsodium. */
export const CHUNK_TAG = 16;

export const FULL_CIPHER_CHUNK = PT_CHUNK + CHUNK_TAG;

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

export function chunkCount(size: number): number {
  if (size <= 0) return 1;
  return Math.ceil(size / PT_CHUNK);
}

/** Length of the cf=2 content region for size plaintext bytes. */
export function cipherLengthForSize(size: number): number {
  const n = chunkCount(size);
  return size + n * CHUNK_TAG;
}
