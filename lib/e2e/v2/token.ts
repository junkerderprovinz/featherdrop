// The v2 link token and the shapes of the keys derived from it. The page reads
// tokens without libsodium; ./keys.ts derives the keys in the crypto worker.

import { toBase64url, fromBase64url } from "../base64";

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

export const MODE_BYTES: Record<Mode, number> = { link: 0x01, "link+password": 0x02 };
export const SECRET_BYTES = 32;
const TOKEN_BYTES = 2 + SECRET_BYTES;
const TOKEN_CHARS = 46;

/** NIST SP 800-63B's floor; the password is a second factor next to the token. */
export const MIN_PASSWORD_LENGTH = 8;

// Without normalization a password typed on macOS (NFD) would not match the
// same password typed elsewhere (NFC).
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

export function isPasswordLongEnough(password: string): boolean {
  return [...normalizePassword(password)].length >= MIN_PASSWORD_LENGTH;
}

/** base64url of version, mode byte and S: 46 characters for the URL fragment. */
export function encodeToken(token: LinkToken): string {
  const raw = new Uint8Array(TOKEN_BYTES);
  raw[0] = FORMAT_VERSION;
  raw[1] = MODE_BYTES[token.mode];
  raw.set(token.secret, 2);
  return toBase64url(raw);
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
