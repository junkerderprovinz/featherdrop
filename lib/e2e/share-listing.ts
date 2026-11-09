// Lists what a share holds before the counted download. The server hands out
// the blob header without counting it, [varint(metaLen)][enc_meta] in formats
// 2 and 3 and the prefix and sealed header in format 4, and only to a client
// that proves it knows the key; the crypto worker opens the names and sizes
// inside.

import { isV2Link, type ShareKeys } from "./v2/token";
import type { Client, LegacyKey } from "./v2/protocol";

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
export async function listShareFiles(
  crypto: Client,
  header: Uint8Array,
  key: Uint8Array,
  format: number,
): Promise<ListedFile[]> {
  if (format === 2) {
    const { name, type, size } = (await crypto.request({ op: "legacy-meta", key, data: header })).meta;
    return [size === undefined ? { name, type } : { name, type, size }];
  }
  if (format === 3) {
    const { manifest } = await crypto.request({ op: "legacy-manifest", key, data: header });
    return manifest.files.map(({ name, type, size }) => ({ name, type, size }));
  }
  throw new Error(`share listing: format ${format} is not supported`);
}

/** Opens the sealed header of a format 4 share and returns its files. */
export async function listV2ShareFiles(crypto: Client, header: Uint8Array, keys: ShareKeys): Promise<ListedFile[]> {
  const opened = await crypto.request({ op: "header", keys, data: header });
  return opened.header.files.map(({ name, type, size }) => ({ name, type, size }));
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
  crypto: Client,
  slug: string,
  key: LegacyKey,
  format: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ListedFile[]> {
  const header = await fetchShareHeader(slug, key.verifier, fetchImpl);
  return listShareFiles(crypto, header, key.key, format);
}

/** What the key in a share link opens: v2 keys or the content key of formats 2 and 3. */
export type LinkKeys = { format: 4; keys: ShareKeys } | { format: 2 | 3; key: LegacyKey };

/**
 * Derives the keys for the #k= value of a share link. The link decides the
 * path: a v2 token is refused unless the server reports format 4 and a bare
 * key is refused for format 4, so a server cannot move a v2 link onto an older
 * format. A link-and-password token needs the password, and the one Argon2id
 * run serves both the listing and the download.
 */
export async function openLink(
  crypto: Client,
  linkKey: string,
  serverFormat: number,
  password?: string,
): Promise<LinkKeys> {
  if (isV2Link(linkKey)) {
    if (serverFormat !== 4) throw new Error(`share listing: a v2 link cannot open format ${serverFormat}`);
    return { format: 4, keys: (await crypto.request({ op: "keys", token: linkKey, password })).keys };
  }
  if (serverFormat !== 2 && serverFormat !== 3) {
    throw new Error(`share listing: a bare key cannot open format ${serverFormat}`);
  }
  return { format: serverFormat, key: await crypto.request({ op: "legacy-key", secret: { keyFromUrl: linkKey } }) };
}

/** Lists a share's files with the keys from openLink. */
export async function fetchLinkListing(
  crypto: Client,
  slug: string,
  link: LinkKeys,
  fetchImpl: typeof fetch = fetch,
): Promise<ListedFile[]> {
  if (link.format === 4) {
    return listV2ShareFiles(crypto, await fetchShareHeader(slug, link.keys.verifier, fetchImpl), link.keys);
  }
  return fetchShareListing(crypto, slug, link.key, link.format, fetchImpl);
}
