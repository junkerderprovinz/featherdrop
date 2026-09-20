import { createHash, timingSafeEqual } from "node:crypto";

// The download token for password-protected shares is derived from the stored
// password hash, which never leaves the server, so it cannot be forged from the
// slug in the URL. Being deterministic, it needs no session state: the handler
// recomputes it from the row and compares it with the cookie.
export function downloadToken(passwordHash: string): string {
  return createHash("sha256")
    .update(`featherdrop:dl:${passwordHash}`)
    .digest("hex");
}

/**
 * Checks in constant time that a cookie holds the download token for a
 * password hash. The mere presence of a cookie must not authorize a download.
 */
export function tokenMatches(
  cookie: string | undefined,
  passwordHash: string,
): boolean {
  if (!cookie) return false;
  const expected = Buffer.from(downloadToken(passwordHash));
  const actual = Buffer.from(cookie);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
