import { createHash } from "node:crypto";

// Download-permission token for password-protected shares.
//
// Derived from the share's stored password hash — which never leaves the server
// — so it cannot be forged from public information. (An earlier version used the
// slug itself, which is in the URL and therefore trivially guessable: setting
// the cookie to the slug bypassed the password entirely.)
//
// Deterministic, so verification needs no server-side session state: the GET
// handler recomputes the expected token from the row's password_hash and
// compares it to the cookie.
export function downloadToken(passwordHash: string): string {
  return createHash("sha256")
    .update(`featherdrop:dl:${passwordHash}`)
    .digest("hex");
}
