// Multi-file shares (format 3) pack several files into one plaintext stream,
// the file bytes concatenated in manifest order, plus an encrypted manifest of
// names, types and sizes. The server stores one opaque blob and never learns it
// holds several files; the download splits the stream back by the sizes.

import {
  encryptManifest as encryptManifestRaw,
  decryptManifest as decryptManifestRaw,
} from "./crypto";

export interface ManifestEntry {
  name: string;
  type: string;
  size: number;
}

export interface Manifest {
  files: ManifestEntry[];
  /** Content format as in FileMeta.cf: 2 is seekable, absent means 1. */
  cf?: 1 | 2;
  /** cf=2 plaintext chunk size. */
  chunkSize?: number;
  /** cf=2 random base nonce in base64. */
  baseNonce?: string;
  /** cf=2 total plaintext length, which the seekable decrypt authenticates. */
  size?: number;
}

/** A file to pack: its metadata and a factory for its plaintext stream. */
export interface PackFile {
  name: string;
  type: string;
  size: number;
  stream: () => AsyncIterable<Uint8Array>;
}

/** Builds the manifest; its order is both the concatenation and the split order. */
export function buildManifest(files: PackFile[]): Manifest {
  return {
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
  };
}

export function encryptManifest(manifest: Manifest, key: Uint8Array): Uint8Array {
  return encryptManifestRaw(manifest, key);
}

/** Reverse of encryptManifest. Throws on a wrong key or a tampered blob. */
export function decryptManifest(blob: Uint8Array, key: Uint8Array): Manifest {
  return decryptManifestRaw<Manifest>(blob, key);
}

/**
 * Concatenates the files' streams in manifest order. The sizes come from
 * File.size at selection but the bytes are read later, so a file that changed
 * on disk in between would mis-slice the download; a byte count that differs
 * from the declared size throws here instead.
 */
export async function* concatFiles(files: PackFile[]): AsyncGenerator<Uint8Array> {
  for (const f of files) {
    let emitted = 0;
    for await (const chunk of f.stream()) {
      emitted += chunk.length;
      if (emitted > f.size) {
        throw new Error(
          `multi-file: "${f.name}" grew during upload ` +
            `(expected ${f.size} bytes, got more); please retry`,
        );
      }
      if (chunk.length > 0) yield chunk;
    }
    if (emitted !== f.size) {
      throw new Error(
        `multi-file: "${f.name}" changed during upload ` +
          `(expected ${f.size} bytes, got ${emitted}); please retry`,
      );
    }
  }
}

/**
 * Splits one plaintext stream back into per-file streams by the manifest sizes,
 * in order. The per-file generators share the source, so each must be drained
 * before the next is requested. Throws if the source ends early.
 */
export async function* splitByManifest(
  source: AsyncIterable<Uint8Array>,
  manifest: Manifest,
): AsyncGenerator<{ entry: ManifestEntry; bytes: AsyncGenerator<Uint8Array> }> {
  const iter = source[Symbol.asyncIterator]();
  let buffer: Uint8Array = new Uint8Array(0);
  let ended = false;

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
