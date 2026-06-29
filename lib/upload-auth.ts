import { timingSafeEqual } from "node:crypto";
import { UPLOAD_PASSWORD, UPLOAD_PROTECTED } from "./config";

// Optional upload gate (see lib/config.ts `UPLOAD_PASSWORD`).
//
// When the operator sets UPLOAD_PASSWORD, creating a share requires it: the
// client sends the secret in the `x-fd-upload-token` request header, and the
// server enforces it on BOTH write paths (the tus upload endpoint and
// /api/finalize) BEFORE any bytes are stored or any DB row is written. A
// mismatch or absent token is a 401. Downloads are never affected.
//
// The comparison is constant-time (timingSafeEqual), like the existing
// key-verifier / download-token checks — the provided token is compared against
// the configured secret so a wrong-length or wrong-content guess takes the same
// time, leaking nothing about the secret. The secret itself never leaves the
// server (no logging, never sent to the client config — only the boolean
// UPLOAD_PROTECTED is).

/** The header the client attaches the upload secret to. */
export const UPLOAD_TOKEN_HEADER = "x-fd-upload-token";

/**
 * Constant-time check of a client-supplied token against the configured upload
 * secret. `timingSafeEqual` throws on unequal-length buffers, so a length
 * mismatch is compared against a same-length dummy instead — rejecting in the
 * same time as a content mismatch, never via an early-exit length shortcut.
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
 * Authorize a write request (tus upload or finalize) against UPLOAD_PASSWORD.
 *
 * - Not protected (UPLOAD_PASSWORD empty/unset) → always authorized (open).
 * - Protected → the request must carry a matching `x-fd-upload-token`.
 *
 * Header values can arrive as `string | string[] | undefined` (Node) — only a
 * single non-empty string can ever match; anything else is rejected.
 */
export function isUploadAuthorized(
  token: string | string[] | undefined,
): boolean {
  if (!UPLOAD_PROTECTED) return true;
  if (typeof token !== "string" || token.length === 0) return false;
  return uploadTokenMatches(token, UPLOAD_PASSWORD);
}
