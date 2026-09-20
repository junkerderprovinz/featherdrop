import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The manage token lets an uploader delete a share early. The raw token rides
// in the management link's fragment like the content key, and only its SHA-256
// hash is stored, so a stolen database cannot delete shares. The client sends
// it in the `x-fd-manage-token` header rather than the path, which keeps it out
// of access logs. Token and hash are both 43 unpadded base64url characters.
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Returns 32 random bytes as unpadded base64url. */
export function newManageToken(): string {
  return randomBytes(32).toString("base64url");
}

/** base64url(SHA-256(token)), the value that is stored. */
export function hashManageToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function isValidManageToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

export function isValidManageTokenHash(v: unknown): v is string {
  return typeof v === "string" && TOKEN_HASH_RE.test(v);
}

/**
 * Checks in constant time that a raw token hashes to the stored hash. A share
 * without a stored hash never matches.
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
