import { customAlphabet } from "nanoid";

// Leaves out 0, O, 1, l and I, which are easy to misread in a link.
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

/** Generates a random share slug such as "k7Mx9qT2". */
export const newSlug = customAlphabet(ALPHABET, 8);

// File paths are built from tus upload ids, so they must never hold a path
// separator or a traversal sequence.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}
