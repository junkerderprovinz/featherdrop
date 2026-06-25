// Client-side zero-knowledge pipeline for FORMAT 3 (multi-file). Mirrors the
// single-file pipeline (./pipeline.ts) but packs N files into ONE blob:
//
//   enc_meta            = encrypted Manifest { files:[{name,type,size}] }
//   secretstream content = the N files' plaintext bytes concatenated in
//                          manifest order (file0 ‖ file1 ‖ …)
//
// The blob envelope is unchanged — [varint(metaLen)][enc_meta][header][frames] —
// so the server still stores/serves one opaque blob and never learns it holds
// several files. On download the single decrypted plaintext stream is split back
// into per-file streams by the manifest sizes. Pure (no DOM / network) so the
// whole encrypt → blob → decrypt round-trip is unit-testable end-to-end.

import {
  ready,
  generateKey,
  encodeKey,
  encryptChunks,
  decryptChunks,
  computeKeyVerifier,
  wrapKey,
} from "./crypto";
import { assembleBlob, readBlobMeta } from "./blob-layout";
import {
  buildManifest,
  concatFiles,
  splitByManifest,
  encryptManifest,
  decryptManifest,
  type Manifest,
  type ManifestEntry,
  type PackFile,
} from "./multi-file";
import { deriveContentKey, type EncryptResult, type DownloadSecret } from "./pipeline";

/**
 * Encrypt several files into one upload blob + share secret (format 3). Mirrors
 * encryptForUpload: one content key, one keyVerifier, link or password mode.
 */
export async function encryptFilesForUpload(
  files: PackFile[],
  opts?: { password?: string },
): Promise<EncryptResult> {
  await ready();
  const key = generateKey();
  const keyVerifier = computeKeyVerifier(key);
  const manifest = buildManifest(files);
  const encMeta = encryptManifest(manifest, key);
  const blob = assembleBlob(encMeta, encryptChunks(concatFiles(files), key));
  if (opts?.password) {
    return { blob, keyForUrl: "", wrapped: wrapKey(key, opts.password), keyVerifier };
  }
  return { blob, keyForUrl: encodeKey(key), keyVerifier };
}

/** One file unpacked from a format-3 download: its manifest entry + byte stream. */
export interface UnpackedFile {
  entry: ManifestEntry;
  bytes: AsyncGenerator<Uint8Array>;
}

/** A decrypted format-3 download: the manifest plus a generator of per-file streams. */
export interface MultiDownload {
  manifest: Manifest;
  files: AsyncGenerator<UnpackedFile>;
}

/**
 * Decrypt a downloaded format-3 blob with an already-derived content key. Returns
 * the manifest and a generator yielding one entry per file IN ORDER; the caller
 * MUST fully drain each file's `bytes` before requesting the next (they share the
 * underlying decrypted stream).
 */
export async function decryptFilesWithKey(
  ciphertext: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): Promise<MultiDownload> {
  await ready();
  const { encMeta, content } = await readBlobMeta(ciphertext);
  const manifest = decryptManifest(encMeta, key);
  const files = splitByManifest(decryptChunks(content, key), manifest);
  return { manifest, files };
}

/** Decrypt a downloaded format-3 blob from the share secret (URL key or password). */
export async function decryptFilesFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<MultiDownload> {
  return decryptFilesWithKey(ciphertext, await deriveContentKey(secret));
}
