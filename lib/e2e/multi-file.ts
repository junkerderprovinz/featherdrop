// Multi-file bundling for zero-knowledge uploads (format 3). Several files are
// packed into ONE plaintext stream — file bytes concatenated in manifest order —
// plus a manifest describing each file's name/type/size. The existing crypto is
// reused unchanged: encryptMeta() encrypts the manifest, encryptChunks() the
// concatenated stream, so the server still stores one opaque blob and never
// learns it holds several files. On download the single decrypted stream is split
// back into the original files by the manifest sizes.
//
// Pure (no DOM / crypto / network) so the pack -> split round-trip is fully
// unit-testable. The manifest crypto wrappers below are the one exception — they
// just give the shared secretbox helper (crypto.ts) precise Manifest types.

import {
  encryptManifest as encryptManifestRaw,
  decryptManifest as decryptManifestRaw,
} from "./crypto";

export interface ManifestEntry {
  name: string;
  type: string;
  size: number; // plaintext byte length
}

export interface Manifest {
  files: ManifestEntry[];
  /**
   * Content-format selector for the concatenated content (mirrors FileMeta.cf in
   * ./crypto). 1 = libsodium secretstream (sequential, the original encoding);
   * 2 = per-chunk XChaCha20-Poly1305 AEAD (seekable). ABSENT means cf=1 — every
   * multi-file blob written before this field existed decrypts via secretstream.
   * Inside enc_meta, so the server never learns which encoding a blob uses.
   */
  cf?: 1 | 2;
  /** cf=2 only: plaintext chunk size (always PT_CHUNK = 65536). Inside enc_meta. */
  chunkSize?: number;
  /** cf=2 only: per-file random 24-byte base nonce, base64 (see deriveNonce). */
  baseNonce?: string;
  /**
   * cf=2 only: TOTAL plaintext byte length of the concatenated content (the sum of
   * the per-file sizes). The seekable decrypt authenticates this length.
   */
  size?: number;
}

/** A file to pack: its metadata plus a factory for its plaintext byte stream. */
export interface PackFile {
  name: string;
  type: string;
  size: number;
  stream: () => AsyncIterable<Uint8Array>;
}

/** Build the manifest. Order defines both concatenation and split order. */
export function buildManifest(files: PackFile[]): Manifest {
  return {
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
  };
}

/**
 * Encrypt the manifest into enc_meta bytes (format 3). Delegates to the shared
 * secretbox helper in crypto.ts; this wrapper only pins the precise Manifest
 * type the pipeline works with.
 */
export function encryptManifest(manifest: Manifest, key: Uint8Array): Uint8Array {
  return encryptManifestRaw(manifest, key);
}

/** Reverse of encryptManifest. Throws on a wrong key or a tampered blob. */
export function decryptManifest(blob: Uint8Array, key: Uint8Array): Manifest {
  return decryptManifestRaw<Manifest>(blob, key);
}

/**
 * Concatenate the files' byte streams into one stream, in manifest order.
 *
 * Defense-in-depth: the manifest sizes are captured from `File.size` at
 * selection but the bytes are streamed later, so a file that changed on disk in
 * between would silently mis-slice the download (each file is split back out by
 * its manifest size). Count the bytes actually emitted per file and throw a
 * clear error if a file yields MORE or FEWER bytes than its declared `size`, so
 * a drift fails loudly at encrypt time instead of corrupting the split.
 */
export async function* concatFiles(files: PackFile[]): AsyncGenerator<Uint8Array> {
  for (const f of files) {
    let emitted = 0;
    for await (const chunk of f.stream()) {
      emitted += chunk.length;
      if (emitted > f.size) {
        throw new Error(
          `multi-file: "${f.name}" grew during upload ` +
            `(expected ${f.size} bytes, got more) — please retry`,
        );
      }
      if (chunk.length > 0) yield chunk;
    }
    if (emitted !== f.size) {
      throw new Error(
        `multi-file: "${f.name}" changed during upload ` +
          `(expected ${f.size} bytes, got ${emitted}) — please retry`,
      );
    }
  }
}

/**
 * Split one plaintext stream back into per-file byte streams using the manifest
 * sizes. Yields one entry per file IN ORDER; the caller MUST fully drain each
 * `bytes` generator before requesting the next (they share the underlying
 * source iterator). Throws if the source ends before every size is satisfied.
 */
export async function* splitByManifest(
  source: AsyncIterable<Uint8Array>,
  manifest: Manifest,
): AsyncGenerator<{ entry: ManifestEntry; bytes: AsyncGenerator<Uint8Array> }> {
  const iter = source[Symbol.asyncIterator]();
  let buffer: Uint8Array = new Uint8Array(0);
  let ended = false;

  // Ensure `buffer` holds at least one byte, pulling from the source as needed.
  async function fill(): Promise<boolean> {
    while (buffer.length === 0) {
      if (ended) return false;
      const r = await iter.next();
      if (r.done) {
        ended = true;
        return false;
      }
      buffer = r.value;
    }
    return true;
  }

  for (const entry of manifest.files) {
    let remaining = entry.size;
    async function* bytes(): AsyncGenerator<Uint8Array> {
      while (remaining > 0) {
        if (!(await fill())) throw new Error("multi-file: stream truncated");
        const take = Math.min(remaining, buffer.length);
        yield buffer.subarray(0, take);
        buffer = buffer.subarray(take);
        remaining -= take;
      }
    }
    yield { entry, bytes: bytes() };
  }
}
