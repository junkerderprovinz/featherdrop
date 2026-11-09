// The format 3 counterpart of ./pipeline.ts. enc_meta holds the encrypted
// Manifest and the content is the files' bytes concatenated in manifest order,
// in the same [varint(metaLen)][enc_meta][content] envelope, so the server sees
// one opaque blob.

import {
  ready,
  generateKey,
  encodeKey,
  decryptChunks,
  computeKeyVerifier,
  wrapKey,
  generateAeadBaseNonce,
  toBase64,
  fromBase64,
  encryptManifest,
  decryptManifest,
} from "./crypto";
import { PT_CHUNK } from "./chunks";
import { assembleBlob, readBlobMeta } from "./blob-layout";
import { encryptSeekable, decryptSeekable } from "./seekable";
import {
  buildManifest,
  splitByManifest,
  type Manifest,
  type ManifestEntry,
} from "./multi-file";
import { deriveContentKey, type EncryptResult, type DownloadSecret } from "./pipeline";

/**
 * Encrypts several files into one upload blob, like encryptForUpload. content
 * is their bytes in order, as concatFiles gives them. New uploads use the
 * seekable cf=2 format, so the manifest also carries the base nonce, chunk
 * size and total plaintext size.
 */
export async function encryptFilesForUpload(
  files: ManifestEntry[],
  content: AsyncIterable<Uint8Array>,
  opts?: { password?: string },
): Promise<EncryptResult> {
  await ready();
  const key = generateKey();
  const keyVerifier = computeKeyVerifier(key);
  const manifest = buildManifest(files);
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
  const blob = assembleBlob(encMeta, encryptSeekable(content, key, baseNonce));
  if (opts?.password) {
    return { blob, keyForUrl: "", wrapped: wrapKey(key, opts.password), keyVerifier };
  }
  return { blob, keyForUrl: encodeKey(key), keyVerifier };
}

/** One file unpacked from a format 3 download. */
export interface UnpackedFile {
  entry: ManifestEntry;
  bytes: AsyncGenerator<Uint8Array>;
}

export interface MultiDownload {
  manifest: Manifest;
  files: AsyncGenerator<UnpackedFile>;
}

/**
 * Decrypts a format 3 blob with a derived content key into its manifest and
 * the files' bytes laid end to end.
 */
export async function decryptBundle(
  ciphertext: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): Promise<{ manifest: Manifest; plaintext: AsyncIterable<Uint8Array> }> {
  await ready();
  const { encMeta, content } = await readBlobMeta(ciphertext);
  const manifest = decryptManifest<Manifest>(encMeta, key);
  // Blobs written before cf=2 existed have no cf and use the secretstream.
  if (manifest.cf === 2) {
    if (manifest.baseNonce === undefined || manifest.size === undefined) {
      throw new Error("seekable multi-file blob missing baseNonce/size in enc_meta");
    }
    const plaintext = decryptSeekable(content, key, fromBase64(manifest.baseNonce), manifest.size);
    return { manifest, plaintext };
  }
  return { manifest, plaintext: decryptChunks(content, key) };
}

/**
 * Decrypts a format 3 blob with a derived content key. The files come in
 * order and share one stream, so each file's bytes must be drained before the
 * next is requested.
 */
export async function decryptFilesWithKey(
  ciphertext: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): Promise<MultiDownload> {
  const { manifest, plaintext } = await decryptBundle(ciphertext, key);
  return { manifest, files: splitByManifest(plaintext, manifest) };
}

/** Decrypts a format 3 blob from the share secret, URL key or password. */
export async function decryptFilesFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<MultiDownload> {
  return decryptFilesWithKey(ciphertext, await deriveContentKey(secret));
}
