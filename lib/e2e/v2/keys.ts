// The v2 key schedule. A link token carries the mode and a fresh 32-byte
// secret S. The root key R comes from S alone in link mode and from S and an
// Argon2id hash of the password otherwise; every working key is a crypto_kdf
// subkey of R, so no key serves two primitives. See docs/encryption-format.md.

import { loadSodium } from "../crypto";

export type Mode = "link" | "link+password";

export interface LinkToken {
  mode: Mode;
  secret: Uint8Array;
}

export interface KdfParams {
  alg: "argon2id13";
  ops: number;
  mem: number;
}

export interface ShareKeys {
  mode: Mode;
  /** The Argon2id parameters used, null in link mode. */
  kdf: KdfParams | null;
  header: Uint8Array;
  content: Uint8Array;
  /** base64url, 43 characters; the server compares it before serving the blob. */
  verifier: string;
}

export const FORMAT_VERSION = 0x02;

const MODE_BYTES: Record<Mode, number> = { link: 0x01, "link+password": 0x02 };
const SECRET_BYTES = 32;
const TOKEN_BYTES = 2 + SECRET_BYTES;
const TOKEN_CHARS = 46;

/**
 * RFC 9106's second recommended setting (t=3, m=64 MiB, p=1). libsodium's
 * crypto_pwhash always runs one lane, and 64 MiB still fits the WASM heap of
 * a mobile browser tab.
 */
export const ARGON2ID = { ops: 3, mem: 64 * 1024 * 1024 } as const;

/** NIST SP 800-63B's floor; the password is a second factor next to S. */
export const MIN_PASSWORD_LENGTH = 8;

const ROOT_LABEL = "CastleParcel v2 root";
const SALT_CONTEXT = "CPv2salt";
const KEY_CONTEXT = "CPv2keys";
const SUBKEY_HEADER = 1;
const SUBKEY_CONTENT = 2;
const SUBKEY_VERIFIER = 3;

const utf8 = new TextEncoder();

// Without normalization a password typed on macOS (NFD) would not match the
// same password typed elsewhere (NFC).
function normalize(password: string): string {
  return password.normalize("NFC");
}

export function isPasswordLongEnough(password: string): boolean {
  return [...normalize(password)].length >= MIN_PASSWORD_LENGTH;
}

export async function newToken(mode: Mode): Promise<LinkToken> {
  const sodium = await loadSodium();
  return { mode, secret: sodium.randombytes_buf(SECRET_BYTES) };
}

/** base64url of version, mode byte and S: 46 characters for the URL fragment. */
export function encodeToken(token: LinkToken): string {
  const raw = new Uint8Array(TOKEN_BYTES);
  raw[0] = FORMAT_VERSION;
  raw[1] = MODE_BYTES[token.mode];
  raw.set(token.secret, 2);
  return base64url(raw);
}

/**
 * Whether the #k= value of a link is a v2 token. Older links carry a bare
 * 43-character key, so the length alone tells them apart; decodeToken then
 * checks the version and mode.
 */
export function isV2Link(k: string): boolean {
  return k.length === TOKEN_CHARS;
}

export function decodeToken(s: string): LinkToken {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("link token: not base64url");
  const raw = fromBase64url(s);
  if (raw.length !== TOKEN_BYTES) throw new Error("link token: wrong length");
  if (raw[0] !== FORMAT_VERSION) throw new Error("link token: unknown version");
  const mode = (Object.keys(MODE_BYTES) as Mode[]).find((m) => MODE_BYTES[m] === raw[1]);
  if (!mode) throw new Error("link token: unknown mode");
  return { mode, secret: raw.slice(2) };
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
      utf8.encode(normalize(password)),
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
    verifier: base64url(sub(SUBKEY_VERIFIER)),
  };
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
