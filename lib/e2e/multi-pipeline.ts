// The format 3 counterpart of ./pipeline.ts. enc_meta holds the encrypted
// Manifest and the content is the files' bytes concatenated in manifest order,
// in the same [varint(metaLen)][enc_meta][content] envelope, so the server sees
// one opaque blob.

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
 * Encrypts several files into one upload blob, like encryptForUpload. New
 * uploads use the seekable cf=2 format, so the manifest also carries the base
 * nonce, chunk size and total plaintext size.
 */
export async function encryptFilesForUpload(
  files: PackFile[],
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
  const blob = assembleBlob(
    encMeta,
    encryptSeekable(concatFiles(files), key, baseNonce),
  );
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
 * Decrypts a format 3 blob with a derived content key. The files come in
 * order and share one stream, so each file's bytes must be drained before the
 * next is requested.
 */
export async function decryptFilesWithKey(
  ciphertext: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): Promise<MultiDownload> {
  await ready();
  const { encMeta, content } = await readBlobMeta(ciphertext);
  const manifest = decryptManifest(encMeta, key);
  // Blobs written before cf=2 existed have no cf and use the secretstream.
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

/** Decrypts a format 3 blob from the share secret, URL key or password. */
export async function decryptFilesFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<MultiDownload> {
  return decryptFilesWithKey(ciphertext, await deriveContentKey(secret));
}
