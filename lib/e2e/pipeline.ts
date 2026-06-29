// Client-side zero-knowledge pipeline: ties together crypto + blob-layout into
// the two operations the UI performs. Pure (no DOM/network) so the whole
// encrypt→blob→decrypt round-trip is unit-testable end-to-end.
//
// Upload:   plaintext stream + meta  ->  { blob stream, share secret }
// Download: ciphertext stream + secret  ->  { meta, plaintext stream }
//
// The server only ever stores/serves the opaque `blob` bytes; the key never
// reaches it (link mode: in the URL #fragment; password mode: derived client-side).

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

/** Wrapped content key for password mode (stored opaquely on the server). */
export interface WrappedKey {
  wrapped: Uint8Array;
  salt: Uint8Array;
}

export interface EncryptResult {
  /** Opaque upload bytes: [varint(metaLen)][enc_meta][secretstream header][frames]. */
  blob: AsyncIterable<Uint8Array>;
  /** base64url content key for the share URL `#k=` (link mode); "" in password mode. */
  keyForUrl: string;
  /** Present only in password mode — server stores this, the link carries no key. */
  wrapped?: WrappedKey;
  /**
   * base64url(SHA-256(K)) — sent to finalize so the server can demand the same
   * proof (header `x-fd-key-verifier`) before counting a download. One-way:
   * the server learns nothing that helps decryption.
   */
  keyVerifier: string;
}

/**
 * Encrypt a plaintext stream + metadata into the upload blob + share secret.
 *
 * `opts.seekable` selects the content encoding:
 *   - false / absent → cf=1 (libsodium secretstream, the original encoding). The
 *     enc_meta omits cf/baseNonce/chunkSize, so the blob is BYTE-IDENTICAL to
 *     what previous versions wrote. This path is unchanged.
 *   - true → cf=2 (per-chunk XChaCha20-Poly1305 AEAD, ./seekable.ts). enc_meta
 *     records cf:2, the per-file baseNonce (b64) and chunkSize so the download
 *     side can seek. `meta.size` should be set (the seekable decrypt verifies
 *     the authenticated length); if omitted it is not added.
 *
 * Both encodings live INSIDE the encrypted enc_meta, so the server can never
 * tell which one a blob uses (zero-knowledge preserved).
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

/** The secret needed to decrypt a download: a link key, or a password + wrap. */
export type DownloadSecret =
  | { keyFromUrl: string }
  | { password: string; wrapped: Uint8Array; salt: Uint8Array };

/**
 * Derive the raw content key K from the share secret — URL key (decode) or
 * password (Argon2id unwrap; throws on a wrong password). Exposed so the
 * download flow can derive K BEFORE fetching: it needs `computeKeyVerifier(K)`
 * for the request, and a wrong password must fail before any download is
 * counted server-side.
 */
export async function deriveContentKey(secret: DownloadSecret): Promise<Uint8Array> {
  await ready();
  return "keyFromUrl" in secret
    ? decodeKey(secret.keyFromUrl)
    : unwrapKey(secret.wrapped, secret.salt, secret.password);
}

/** Decrypt a downloaded blob stream back into its metadata + plaintext stream. */
export async function decryptFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<{ meta: FileMeta; plaintext: AsyncIterable<Uint8Array> }> {
  // The content key is derivable from the secret alone (URL key, or unwrap with
  // the password) — no server data needed beyond the opaque wrapped key/salt.
  return decryptWithKey(ciphertext, await deriveContentKey(secret));
}

/**
 * Decrypt with an already-derived content key (skips the Argon2id re-derive).
 *
 * Branches on the content-format `cf` carried INSIDE the (now-decrypted) enc_meta:
 *   - cf absent or 1 → the original secretstream path (decryptChunks). Every blob
 *     written before cf=2 existed has no `cf` field, so old links keep working.
 *   - cf === 2 → the seekable per-chunk path (decryptSeekable), using the
 *     baseNonce + authenticated size from enc_meta.
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
  // cf absent / cf === 1 → legacy secretstream path (untouched).
  const plaintext = decryptChunks(content, key);
  return { meta, plaintext };
}
