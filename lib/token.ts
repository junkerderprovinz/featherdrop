import { createHash, timingSafeEqual } from "node:crypto";

// Download-permission token for password-protected shares.
//
// Derived from the share's stored password hash — which never leaves the server
// — so it cannot be forged from public information. (An earlier version used the
// slug itself, which is in the URL and therefore trivially guessable: setting
// the cookie to the slug bypassed the password entirely.)
//
// Deterministic, so verification needs no server-side session state: the GET
// handler recomputes the expected token from the row's password_hash and
// compares it (constant-time) to the cookie.
export function downloadToken(passwordHash: string): string {
  return createHash("sha256")
    .update(`featherdrop:dl:${passwordHash}`)
    .digest("hex");
}

/**
 * Constant-time check that a cookie value is the valid download token for a
 * password hash. Authorizing on cookie *presence* alone is a bypass — any
 * non-empty value would pass — so the value must equal the hash-derived token.
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
