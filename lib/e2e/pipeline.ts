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
  type FileMeta,
} from "./crypto";
import { assembleBlob, readBlobMeta } from "./blob-layout";

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
}

/** Encrypt a plaintext stream + metadata into the upload blob + share secret. */
export async function encryptForUpload(
  content: AsyncIterable<Uint8Array>,
  meta: FileMeta,
  opts?: { password?: string },
): Promise<EncryptResult> {
  await ready();
  const key = generateKey();
  const encMeta = encryptMeta(meta, key);
  const blob = assembleBlob(encMeta, encryptChunks(content, key));
  if (opts?.password) {
    return { blob, keyForUrl: "", wrapped: wrapKey(key, opts.password) };
  }
  return { blob, keyForUrl: encodeKey(key) };
}

/** The secret needed to decrypt a download: a link key, or a password + wrap. */
export type DownloadSecret =
  | { keyFromUrl: string }
  | { password: string; wrapped: Uint8Array; salt: Uint8Array };

/** Decrypt a downloaded blob stream back into its metadata + plaintext stream. */
export async function decryptFromDownload(
  ciphertext: AsyncIterable<Uint8Array>,
  secret: DownloadSecret,
): Promise<{ meta: FileMeta; plaintext: AsyncIterable<Uint8Array> }> {
  await ready();
  // The content key is derivable from the secret alone (URL key, or unwrap with
  // the password) — no server data needed beyond the opaque wrapped key/salt.
  const key =
    "keyFromUrl" in secret
      ? decodeKey(secret.keyFromUrl)
      : unwrapKey(secret.wrapped, secret.salt, secret.password);

  const { encMeta, content } = await readBlobMeta(ciphertext);
  const meta = decryptMeta(encMeta, key);
  const plaintext = decryptChunks(content, key);
  return { meta, plaintext };
}
