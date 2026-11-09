// The v2 key schedule. A link token carries the mode and a fresh 32-byte
// secret S. The root key R comes from S alone in link mode and from S and an
// Argon2id hash of the password otherwise; every working key is a crypto_kdf
// subkey of R, so no key serves two primitives. See docs/encryption-format.md.

import { loadSodium } from "../crypto";
import { toBase64url } from "../base64";
import {
  MODE_BYTES,
  SECRET_BYTES,
  normalizePassword,
  type LinkToken,
  type Mode,
  type ShareKeys,
} from "./token";

/**
 * The time and memory cost of RFC 9106's second recommended setting (t=3,
 * m=64 MiB). The RFC names four lanes, but libsodium's crypto_pwhash always
 * runs one, and 64 MiB still fits the WASM heap of a mobile browser tab.
 */
export const ARGON2ID = { ops: 3, mem: 64 * 1024 * 1024 } as const;

const ROOT_LABEL = "CastleParcel v2 root";
const SALT_CONTEXT = "CPv2salt";
const KEY_CONTEXT = "CPv2keys";
const SUBKEY_HEADER = 1;
const SUBKEY_CONTENT = 2;
const SUBKEY_VERIFIER = 3;

const utf8 = new TextEncoder();

export async function newToken(mode: Mode): Promise<LinkToken> {
  const sodium = await loadSodium();
  return { mode, secret: sodium.randombytes_buf(SECRET_BYTES) };
}

/**
 * The Argon2id salt, a subkey of S. It is unique per share and never stored on
 * the server, so the server cannot start guessing the password.
 */
export async function passwordSalt(secret: Uint8Array): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sodium.crypto_kdf_derive_from_key(sodium.crypto_pwhash_SALTBYTES, 1, SALT_CONTEXT, secret);
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/**
 * R = BLAKE2b-256(key = S, label || mode || u32be(ops) || u32be(mem) || P),
 * where P is the Argon2id output, or empty with zero parameters in link mode.
 */
export async function rootKey(token: LinkToken, password?: string): Promise<Uint8Array> {
  const sodium = await loadSodium();
  if (token.secret.length !== SECRET_BYTES) throw new Error("link token: wrong secret length");
  let ops = 0;
  let mem = 0;
  let stretched: Uint8Array = new Uint8Array(0);
  if (token.mode === "link+password") {
    if (password === undefined) throw new Error("this link needs a password");
    ({ ops, mem } = ARGON2ID);
    stretched = sodium.crypto_pwhash(
      32,
      utf8.encode(normalizePassword(password)),
      await passwordSalt(token.secret),
      ops,
      mem,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } else if (password !== undefined) {
    throw new Error("this link takes no password");
  }
  const label = utf8.encode(ROOT_LABEL);
  const msg = new Uint8Array(label.length + 9 + stretched.length);
  msg.set(label, 0);
  msg[label.length] = MODE_BYTES[token.mode];
  msg.set(u32be(ops), label.length + 1);
  msg.set(u32be(mem), label.length + 5);
  msg.set(stretched, label.length + 9);
  return sodium.crypto_generichash(32, msg, token.secret);
}

export async function deriveKeys(token: LinkToken, password?: string): Promise<ShareKeys> {
  const sodium = await loadSodium();
  const root = await rootKey(token, password);
  const sub = (id: number) => sodium.crypto_kdf_derive_from_key(32, id, KEY_CONTEXT, root);
  return {
    mode: token.mode,
    kdf: token.mode === "link+password" ? { alg: "argon2id13", ...ARGON2ID } : null,
    header: sub(SUBKEY_HEADER),
    content: sub(SUBKEY_CONTENT),
    verifier: toBase64url(sub(SUBKEY_VERIFIER)),
  };
}
