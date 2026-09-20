// The client-side encryption pipeline behind upload and download:
//
// Upload:   plaintext stream + meta     ->  { blob stream, share secret }
// Download: ciphertext stream + secret  ->  { meta, plaintext stream }
//
// The server only stores the opaque blob. The key never reaches it: it rides in
// the URL fragment in link mode and is derived from the password otherwise.

import {
  ready,
  generateKey,
  encodeKey,
  decodeKey,
  encryptChunks,
  decryptChunks,
  encryptMeta,
  decryptMeta,
  wrapKey,
  unwrapKey,
  computeKeyVerifier,
  generateAeadBaseNonce,
  toBase64,
  fromBase64,
  PT_CHUNK,
  type FileMeta,
} from "./crypto";
import { assembleBlob, readBlobMeta } from "./blob-layout";
import { encryptSeekable, decryptSeekable } from "./seekable";

/** The content key wrapped for password mode, stored opaquely on the server. */
export interface WrappedKey {
  wrapped: Uint8Array;
  salt: Uint8Array;
}

export interface EncryptResult {
  /** The upload bytes: [varint(metaLen)][enc_meta][content]. */
  blob: AsyncIterable<Uint8Array>;
  /** base64url content key for the `#k=` fragment; "" in password mode. */
  keyForUrl: string;
  /** Password mode only: stored by the server, the link carries no key. */
  wrapped?: WrappedKey;
  /**
   * base64url(SHA-256(K)), sent to finalize so the server can require the same
   * proof before counting a download.
   */
  keyVerifier: string;
}

/**
 * Encrypts a plaintext stream and its metadata into the upload blob and share
 * secret. Without opts.seekable the content is a cf=1 secretstream and the blob
 * is byte-identical to what older versions wrote. With it the content is cf=2
 * (./seekable.ts) and meta.size should be set, since the seekable decrypt
 * checks it.
 */
export async function encryptForUpload(
  content: AsyncIterable<Uint8Array>,
  meta: FileMeta,
  opts?: { password?: string; seekable?: boolean },
): Promise<EncryptResult> {
  await ready();
  const key = generateKey();
  const keyVerifier = computeKeyVerifier(key);

  let encMeta: Uint8Array;
  let blob: AsyncIterable<Uint8Array>;
  if (opts?.seekable) {
    const baseNonce = generateAeadBaseNonce();
    const seekableMeta: FileMeta = {
      ...meta,
      cf: 2,
      chunkSize: PT_CHUNK,
      baseNonce: toBase64(baseNonce),
    };
    encMeta = encryptMeta(seekableMeta, key);
    blob = assembleBlob(encMeta, encryptSeekable(content, key, baseNonce));
  } else {
    encMeta = encryptMeta(meta, key);
    blob = assembleBlob(encMeta, encryptChunks(content, key));
  }

  if (opts?.password) {
    return { blob, keyForUrl: "", wrapped: wrapKey(key, opts.password), keyVerifier };
  }
  return { blob, keyForUrl: encodeKey(key), keyVerifier };
}

/** The secret that decrypts a download: a link key, or a password and its wrap. */
export type DownloadSecret =
  | { keyFromUrl: string }
  | { password: string; wrapped: Uint8Array; salt: Uint8Array };

/**
 * Derives the content key from the share secret; a wrong password throws. The
 * download flow calls it before fetching, because the request needs the key
 * verifier and a wrong password must fail before anything is counted.
 */
export async function deriveContentKey(secret: DownloadSecret): Promise<Uint8Array> {
  await ready();
  return "keyFromUrl" in secret
    ? decodeKey(secret.keyFromUrl)
    : unwrapKey(secret.wrapped, secret.salt, secret.password);
}

export async function decryptFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<{ meta: FileMeta; plaintext: AsyncIterable<Uint8Array> }> {
  return decryptWithKey(ciphertext, await deriveContentKey(secret));
}

/**
 * Decrypts with an already derived key, skipping the Argon2id work. Blobs
 * written before cf=2 existed have no cf and use the secretstream path.
 */
export async function decryptWithKey(
  ciphertext: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): Promise<{ meta: FileMeta; plaintext: AsyncIterable<Uint8Array> }> {
  await ready();
  const { encMeta, content } = await readBlobMeta(ciphertext);
  const meta = decryptMeta(encMeta, key);
  if (meta.cf === 2) {
    if (meta.baseNonce === undefined || meta.size === undefined) {
      throw new Error("seekable blob missing baseNonce/size in enc_meta");
    }
    const plaintext = decryptSeekable(
      content,
      key,
      fromBase64(meta.baseNonce),
      meta.size,
    );
    return { meta, plaintext };
  }
  const plaintext = decryptChunks(content, key);
  return { meta, plaintext };
}
