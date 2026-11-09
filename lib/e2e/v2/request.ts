// File requests: someone asks for files without an account. The requester's
// browser draws a 32-byte secret Q and derives from it an X25519 key pair and
// a collect token. The request link carries the public key, the collect link
// carries Q. An uploader encrypts an ordinary link-mode v2 share and seals its
// link token to the public key with crypto_box_seal, so only Q opens it. The
// server stores the public key, which uploaders send as their proof, and the
// hash of the collect token, which the requester sends to list and download.
// See docs/encryption-format.md.

import { loadSodium } from "../crypto";
import { FORMAT_VERSION, decodeToken, encodeToken } from "./keys";

export interface RequestKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** base64url, 43 characters; the server stores only its SHA-256. */
  collectToken: string;
}

const SECRET_BYTES = 32;
const LINK_BYTES = 2 + 32;
// Next to the share token's modes 0x01 and 0x02, so no link of one kind
// decodes as another.
const KIND_COLLECT = 0x10;
const KIND_REQUEST = 0x11;
const CONTEXT = "CPv2rqst";
const SUBKEY_BOX_SEED = 1;
const SUBKEY_COLLECT = 2;

/** 34-byte token, 32-byte ephemeral public key and 16-byte tag. */
export const SEALED_TOKEN_BYTES = 82;

export async function newRequestSecret(): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sodium.randombytes_buf(SECRET_BYTES);
}

/** Derives the key pair and the collect token from the secret Q. */
export async function requestKeys(secret: Uint8Array): Promise<RequestKeys> {
  if (secret.length !== SECRET_BYTES) throw new Error("request: wrong secret length");
  const sodium = await loadSodium();
  const seed = sodium.crypto_kdf_derive_from_key(32, SUBKEY_BOX_SEED, CONTEXT, secret);
  const { publicKey, privateKey } = sodium.crypto_box_seed_keypair(seed);
  const collect = sodium.crypto_kdf_derive_from_key(32, SUBKEY_COLLECT, CONTEXT, secret);
  return { publicKey, secretKey: privateKey, collectToken: base64url(collect) };
}

function encodeLink(kind: number, body: Uint8Array): string {
  const raw = new Uint8Array(LINK_BYTES);
  raw[0] = FORMAT_VERSION;
  raw[1] = kind;
  raw.set(body, 2);
  return base64url(raw);
}

function decodeLink(kind: number, s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("request link: not base64url");
  const raw = fromBase64url(s);
  if (raw.length !== LINK_BYTES) throw new Error("request link: wrong length");
  if (raw[0] !== FORMAT_VERSION) throw new Error("request link: unknown version");
  if (raw[1] !== kind) throw new Error("request link: wrong kind");
  return raw.slice(2);
}

/** The #c= value of a collect link: base64url(version || 0x10 || Q), 46 characters. */
export function encodeCollectLink(secret: Uint8Array): string {
  return encodeLink(KIND_COLLECT, secret);
}

export function decodeCollectLink(s: string): Uint8Array {
  return decodeLink(KIND_COLLECT, s);
}

/** The #p= value of a request link: base64url(version || 0x11 || public key), 46 characters. */
export function encodeRequestKey(publicKey: Uint8Array): string {
  return encodeLink(KIND_REQUEST, publicKey);
}

export function decodeRequestKey(s: string): Uint8Array {
  return decodeLink(KIND_REQUEST, s);
}

/** The public key as the server stores it and uploaders send it: 43 base64url characters. */
export function requestKeyProof(publicKey: Uint8Array): string {
  return base64url(publicKey);
}

/**
 * Seals the link token of a fresh link-mode share to a request's public key.
 * The sealed bytes carry no sender, so they say nothing about the uploader.
 */
export async function sealToken(token: string, publicKey: Uint8Array): Promise<Uint8Array> {
  const decoded = decodeToken(token);
  if (decoded.mode !== "link") throw new Error("request: only a link mode token can be sealed");
  const sodium = await loadSodium();
  return sodium.crypto_box_seal(fromBase64url(token), publicKey);
}

/** Opens a sealed token with the requester's keys and returns the share's link token. */
export async function openSealedToken(sealed: Uint8Array, keys: RequestKeys): Promise<string> {
  const sodium = await loadSodium();
  let raw: Uint8Array;
  try {
    raw = sodium.crypto_box_seal_open(sealed, keys.publicKey, keys.secretKey);
  } catch {
    throw new Error("request: the sealed token does not open (another request or tampered)");
  }
  const token = decodeToken(base64url(raw));
  if (token.mode !== "link") throw new Error("request: a sealed token must be in link mode");
  return encodeToken(token);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
