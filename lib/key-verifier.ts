import { timingSafeEqual } from "node:crypto";

// Key verifier for zero-knowledge (format=2) downloads.
//
// The verifier is base64url(SHA-256(K)) of the raw 32-byte content key K,
// computed by the CLIENT (lib/e2e/crypto.ts `computeKeyVerifier`) — the server
// only ever stores and compares the opaque string. It is one-way: knowing the
// verifier does not allow decryption; it only proves the downloader knows K, so
// someone who merely learned the slug (proxy/access logs) cannot exhaust a
// limited share's download count or burn the file.
//
// SHA-256 is 32 bytes → 43 base64url characters without padding.
const VERIFIER_RE = /^[A-Za-z0-9_-]{43}$/;

/** Finalize-body validation: a 43-char unpadded base64url string. */
export function isValidKeyVerifier(v: unknown): v is string {
  return typeof v === "string" && VERIFIER_RE.test(v);
}

/**
 * Constant-time check of a client-supplied verifier against the stored one.
 * `timingSafeEqual` throws on unequal-length buffers, so a length mismatch is
 * compared against a same-length dummy instead — rejecting in the same time as
 * a content mismatch, never via an early-exit length shortcut.
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
