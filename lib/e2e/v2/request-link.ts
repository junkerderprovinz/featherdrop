// The two links of a file request (see ./request.ts for the keys behind
// them). The page reads and writes them without libsodium.

import { toBase64url, fromBase64url } from "../base64";
import { FORMAT_VERSION } from "./token";

export interface RequestKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** base64url, 43 characters; the server stores only its SHA-256. */
  collectToken: string;
}

export const SECRET_BYTES = 32;
const LINK_BYTES = 2 + 32;
// Next to the share token's modes 0x01 and 0x02, so no link of one kind
// decodes as another.
const KIND_COLLECT = 0x10;
const KIND_REQUEST = 0x11;

/** 34-byte token, 32-byte ephemeral public key and 16-byte tag. */
export const SEALED_TOKEN_BYTES = 82;

export function newRequestSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

function encodeLink(kind: number, body: Uint8Array): string {
  const raw = new Uint8Array(LINK_BYTES);
  raw[0] = FORMAT_VERSION;
  raw[1] = kind;
  raw.set(body, 2);
  return toBase64url(raw);
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
  return toBase64url(publicKey);
}
