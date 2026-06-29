// Client-side zero-knowledge pipeline for FORMAT 3 (multi-file). Mirrors the
// single-file pipeline (./pipeline.ts) but packs N files into ONE blob:
//
//   enc_meta = encrypted Manifest { files:[{name,type,size}], cf, baseNonce,
//              chunkSize, size } — the concatenated plaintext's TOTAL byte length
//   content  = the N files' plaintext bytes concatenated in manifest order
//              (file0 ‖ file1 ‖ …), encrypted as cf=2 seekable per-chunk AEAD for
//              NEW uploads (cf=1 secretstream for blobs written before cf existed).
//
// The blob envelope is unchanged — [varint(metaLen)][enc_meta][content] — so the
// server still stores/serves one opaque blob and never learns it holds several
// files. On download the single decrypted plaintext stream is split back into
// per-file streams by the manifest sizes. The decrypt branches on the manifest's
// `cf` EXACTLY like the single-file pipeline (./pipeline.ts decryptWithKey): cf=2
// → seekable, cf absent/1 → secretstream (so old multi-file links keep working).
// Pure (no DOM / network) so the whole encrypt → blob → decrypt round-trip is
// unit-testable end-to-end.

import {
  ready,
  generateKey,
  encodeKey,
  encryptChunks,
  decryptChunks,
  computeKeyVerifier,
  wrapKey,
  generateAeadBaseNonce,
  toBase64,
  fromBase64,
  PT_CHUNK,
} from "./crypto";
import { assembleBlob, readBlobMeta } from "./blob-layout";
import { encryptSeekable, decryptSeekable } from "./seekable";
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
 *
 * NEW uploads use cf=2 (seekable per-chunk AEAD) for the concatenated content, so
 * the manifest carries cf:2, the per-file baseNonce (b64), chunkSize and the TOTAL
 * concatenated plaintext `size` (the seekable decrypt authenticates that length).
 * All of those live INSIDE enc_meta, so the server stays zero-knowledge.
 */
export async function encryptFilesForUpload(
  files: PackFile[],
  opts?: { password?: string },
): Promise<EncryptResult> {
  await ready();
  const key = generateKey();
  const keyVerifier = computeKeyVerifier(key);
  const manifest = buildManifest(files);
  // Total concatenated plaintext length — the authenticated size the cf=2
  // seekable decrypt verifies (and what splitByManifest's per-file sizes sum to).
  const totalSize = manifest.files.reduce((sum, f) => sum + f.size, 0);
  const baseNonce = generateAeadBaseNonce();
  const seekableManifest: Manifest = {
    ...manifest,
    cf: 2,
    chunkSize: PT_CHUNK,
    baseNonce: toBase64(baseNonce),
    size: totalSize,
  };
  const encMeta = encryptManifest(seekableManifest, key);
  const blob = assembleBlob(
    encMeta,
    encryptSeekable(concatFiles(files), key, baseNonce),
  );
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
  // Branch on the manifest's content-format EXACTLY like pipeline.ts
  // decryptWithKey: cf=2 → seekable per-chunk AEAD; cf absent/1 → secretstream
  // (so multi-file blobs written before cf=2 existed still decrypt). The single
  // decrypted plaintext stream is then split back into per-file streams.
  let plaintext: AsyncIterable<Uint8Array>;
  if (manifest.cf === 2) {
    if (manifest.baseNonce === undefined || manifest.size === undefined) {
      throw new Error("seekable multi-file blob missing baseNonce/size in enc_meta");
    }
    plaintext = decryptSeekable(
      content,
      key,
      fromBase64(manifest.baseNonce),
      manifest.size,
    );
  } else {
    plaintext = decryptChunks(content, key);
  }
  const files = splitByManifest(plaintext, manifest);
  return { manifest, files };
}

/** Decrypt a downloaded format-3 blob from the share secret (URL key or password). */
export async function decryptFilesFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<MultiDownload> {
  return decryptFilesWithKey(ciphertext, await deriveContentKey(secret));
}
