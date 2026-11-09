// Lists what a share holds before the counted download. The server hands out
// the blob header, [varint(metaLen)][enc_meta], without counting it, and only
// to a client that proves it knows the key; the names and sizes inside are
// decrypted here.

import { computeKeyVerifier, decryptMeta } from "./crypto";
import { peekBlobHeader } from "./blob-layout";
import { decryptManifest } from "./multi-file";

export interface ListedFile {
  name: string;
  type: string;
  /** Plaintext size; single-file shares from before it was stored lack it. */
  size?: number;
}

/**
 * Decrypts a blob header into the share's files: one for format 2, the
 * manifest entries for format 3. Throws on a wrong key, a tampered header or
 * an unknown format.
 */
export function listShareFiles(
  header: Uint8Array,
  key: Uint8Array,
  format: number,
): ListedFile[] {
  const { encMeta } = peekBlobHeader(header);
  if (format === 2) {
    const { name, type, size } = decryptMeta(encMeta, key);
    return [size === undefined ? { name, type } : { name, type, size }];
  }
  if (format === 3) {
    return decryptManifest(encMeta, key).files.map(({ name, type, size }) => ({
      name,
      type,
      size,
    }));
  }
  throw new Error(`share listing: format ${format} is not supported`);
}

/** Fetches a share's blob header from GET /api/d/{slug}/header. */
export async function fetchShareHeader(
  slug: string,
  keyVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const res = await fetchImpl(`/api/d/${encodeURIComponent(slug)}/header`, {
    headers: { "x-fd-key-verifier": keyVerifier },
  });
  if (!res.ok) throw new Error(`header ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Lists a share's files with a derived content key, so a password share
 * needs the Argon2id work only once for listing and download.
 */
export async function fetchShareListing(
  slug: string,
  key: Uint8Array,
  format: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ListedFile[]> {
  const header = await fetchShareHeader(slug, computeKeyVerifier(key), fetchImpl);
  return listShareFiles(header, key, format);
}
