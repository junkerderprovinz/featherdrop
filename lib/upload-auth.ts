import { timingSafeEqual } from "node:crypto";
import { UPLOAD_PASSWORD, UPLOAD_PROTECTED } from "./config";

// With UPLOAD_PASSWORD set, creating a share requires the secret in the
// `x-fd-upload-token` header on both the tus endpoint and /api/finalize, checked
// before any byte or row is written. Downloads are never gated, and only the
// UPLOAD_PROTECTED flag ever reaches the client.

export const UPLOAD_TOKEN_HEADER = "x-fd-upload-token";

/**
 * Compares a token with the upload secret in constant time. timingSafeEqual
 * throws on unequal lengths, so a length mismatch runs a dummy compare instead
 * of returning early.
 */
export function uploadTokenMatches(provided: string, secret: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Reports whether a write request passes the upload gate. Without a password
 * everything passes. Node header values may be arrays, and only a single
 * non-empty string can match.
 */
export function isUploadAuthorized(
  token: string | string[] | undefined,
): boolean {
  if (!UPLOAD_PROTECTED) return true;
  if (typeof token !== "string" || token.length === 0) return false;
  return uploadTokenMatches(token, UPLOAD_PASSWORD);
}
