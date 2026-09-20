// What happens to the per-file key of an encrypted upload:
//   - "password": wrapped with the uploader's password.
//   - "server":   wrapped with the server's MASTER_KEY, which gives short links
//                 without a fragment; the server can decrypt.
//   - "link":     carried in the share URL fragment and never stored.
export type EncMode = "password" | "server" | "link";

/**
 * Picks the mode for a new upload. A password always wins; otherwise a master
 * key gives server mode and its absence link mode.
 */
export function chooseEncMode(
  hasPassword: boolean,
  hasMasterKey: boolean,
): EncMode {
  if (hasPassword) return "password";
  return hasMasterKey ? "server" : "link";
}
