import { customAlphabet } from "nanoid";

// URL-safe, unambiguous alphabet (no 0/O/1/l/I) for human-friendly share links.
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

/** Generate a random public share slug, e.g. "k7Mx9qT2". */
export const newSlug = customAlphabet(ALPHABET, 8);

// tus upload ids and our stored filenames must never contain path separators
// or traversal sequences — guard before touching the filesystem with them.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}
