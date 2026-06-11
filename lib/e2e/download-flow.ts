// Download orchestration: fetch encrypted blob → decrypt → save to disk.
// Injected `fetchBlob` and `save` keep this module pure and testable without
// a real server or browser download API.

import { computeKeyVerifier } from "./crypto";
import { deriveContentKey, decryptWithKey } from "./pipeline";
import { streamToAsyncIterable, asyncIterableToStream } from "./stream-adapters";

/**
 * The decryption secret: either the raw key from the URL fragment (link mode)
 * or a password + the wrapped key material stored on the server (password mode).
 */
export type DownloadSecret =
  | { keyFromUrl: string }
  | { password: string; wrapped: Uint8Array; salt: Uint8Array };

/**
 * Download, decrypt, and save a file.
 *
 * Steps:
 *  1. Derive the content key K from the secret — BEFORE any network I/O, so a
 *     wrong password rejects here and never reaches the server (nothing is
 *     fetched, nothing is counted).
 *  2. Fetch the encrypted blob as a ReadableStream. `fetchBlob` receives
 *     base64url(SHA-256(K)) so every call site automatically sends it as the
 *     `x-fd-key-verifier` header — the server requires this proof of key
 *     knowledge before counting/burning the download.
 *  3. Decrypt with K (a tampered blob causes `decryptWithKey` to reject — the
 *     rejection propagates directly to the caller).
 *  4. Pass the plaintext stream to `save`; return the recovered metadata.
 */
export async function downloadDecrypted(
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: DownloadSecret,
  save: (plaintext: ReadableStream<Uint8Array>, filename: string) => Promise<void>,
): Promise<{ meta: { name: string; type: string } }> {
  const key = await deriveContentKey(secret);
  const stream = await fetchBlob(computeKeyVerifier(key));
  const { meta, plaintext } = await decryptWithKey(
    streamToAsyncIterable(stream),
    key,
  );
  await save(asyncIterableToStream(plaintext), meta.name);
  return { meta };
}
