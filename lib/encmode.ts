// The encryption mode for an encrypted upload, deciding what happens to the
// per-file key (see server/crypto.ts):
//   - "password": key wrapped with the uploader's password (true E2E).
//   - "server":   key wrapped with the server MASTER_KEY → short links, no
//                 #fragment; the server can decrypt (but at-rest stays safe).
//   - "link":     key rides in the share URL #fragment, never stored.
export type EncMode = "password" | "server" | "link";

/**
 * Choose the mode for a new upload from whether a password was set and whether
 * a server master key is configured. A password always wins; otherwise a
 * configured master key gives short server-mode links, falling back to link
 * mode when there is no master key.
 */
export function chooseEncMode(
  hasPassword: boolean,
  hasMasterKey: boolean,
): EncMode {
  if (hasPassword) return "password";
  return hasMasterKey ? "server" : "link";
}
