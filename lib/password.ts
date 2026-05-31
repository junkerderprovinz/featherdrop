import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Password hashing for optional per-file protection. Uses scrypt from Node's
// stdlib — no external dependency. Stored format: "scrypt$<saltHex>$<hashHex>".
const KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, expected.length);
  // Lengths match by construction, but guard anyway before timingSafeEqual.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
