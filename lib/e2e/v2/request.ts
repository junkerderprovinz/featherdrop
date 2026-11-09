// File requests: someone asks for files without an account. The requester's
// browser draws a 32-byte secret Q and derives from it an X25519 key pair and
// a collect token. The request link carries the public key, the collect link
// carries Q. An uploader encrypts an ordinary link-mode v2 share and seals its
// link token to the public key with crypto_box_seal, so only Q opens it. The
// server stores the public key, which uploaders send as their proof, and the
// hash of the collect token, which the requester sends to list and download.
// See docs/encryption-format.md.

import { loadSodium } from "../crypto";
import { toBase64url, fromBase64url } from "../base64";
import { decodeToken, encodeToken } from "./token";
import { SECRET_BYTES, type RequestKeys } from "./request-link";

const CONTEXT = "CPv2rqst";
const SUBKEY_BOX_SEED = 1;
const SUBKEY_COLLECT = 2;

/** Derives the key pair and the collect token from the secret Q. */
export async function requestKeys(secret: Uint8Array): Promise<RequestKeys> {
  if (secret.length !== SECRET_BYTES) throw new Error("request: wrong secret length");
  const sodium = await loadSodium();
  const seed = sodium.crypto_kdf_derive_from_key(32, SUBKEY_BOX_SEED, CONTEXT, secret);
  const { publicKey, privateKey } = sodium.crypto_box_seed_keypair(seed);
  const collect = sodium.crypto_kdf_derive_from_key(32, SUBKEY_COLLECT, CONTEXT, secret);
  return { publicKey, secretKey: privateKey, collectToken: toBase64url(collect) };
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
  const token = decodeToken(toBase64url(raw));
  if (token.mode !== "link") throw new Error("request: a sealed token must be in link mode");
  return encodeToken(token);
}
