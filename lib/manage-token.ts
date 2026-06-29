import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Management ("delete early") token for a share.
//
// At finalize the server mints a random 32-byte token, hands the RAW token back
// to the uploader ONCE (it rides in the management link's URL #fragment, exactly
// like the content key) and stores ONLY its SHA-256 hash. The hash is one-way:
// a stolen database/backup cannot reconstruct the token, so it cannot delete a
// share. To revoke a share the client sends the raw token in the
// `x-fd-manage-token` header (never the URL path, so it stays out of access
// logs); the server hashes it and constant-time-compares it to the stored hash.
//
// Mirrors lib/key-verifier.ts: SHA-256 → 43 base64url chars without padding.
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{43}$/;

// A 32-byte random token, base64url without padding (like the slug/content key).
// 32 bytes → 43 base64url characters.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Mint a fresh random manage token (32 random bytes, base64url, unpadded). */
export function newManageToken(): string {
  return randomBytes(32).toString("base64url");
}

/** base64url(SHA-256(token)) — what the server stores; never the raw token. */
export function hashManageToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Shape check for a raw manage token (43-char unpadded base64url). */
export function isValidManageToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

/** Shape check for a stored manage-token hash (43-char unpadded base64url). */
export function isValidManageTokenHash(v: unknown): v is string {
  return typeof v === "string" && TOKEN_HASH_RE.test(v);
}

/**
 * Constant-time check that a raw token hashes to the stored hash.
 * `timingSafeEqual` throws on unequal-length buffers, so a length mismatch is
 * compared against a same-length dummy instead — rejecting in the same time as
 * a content mismatch, never via an early-exit length shortcut. A legacy share
 * with no stored hash (NULL/empty) can never match.
 */
export function manageTokenMatches(
  provided: string | undefined,
  storedHash: string | null,
): boolean {
  if (!provided || !storedHash) return false;
  const a = Buffer.from(hashManageToken(provided));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}
