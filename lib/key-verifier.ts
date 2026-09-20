import { timingSafeEqual } from "node:crypto";

// The key verifier is base64url(SHA-256(K)) of the 32-byte content key,
// computed by the client in lib/e2e/crypto.ts. It only proves the downloader
// knows K, so someone who learned the slug from a proxy or access log cannot
// use up a limited share or burn it.
const VERIFIER_RE = /^[A-Za-z0-9_-]{43}$/;

/** Checks for a 43-character unpadded base64url string. */
export function isValidKeyVerifier(v: unknown): v is string {
  return typeof v === "string" && VERIFIER_RE.test(v);
}

/**
 * Compares a verifier with the stored one in constant time. timingSafeEqual
 * throws on unequal lengths, so a length mismatch runs a dummy compare instead
 * of returning early.
 */
export function verifierMatches(provided: string, stored: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(stored);
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}
