// Download orchestration: fetch encrypted blob → decrypt → save to disk.
// Injected `fetchBlob` and `save` keep this module pure and testable without
// a real server or browser download API.

import { decryptFromDownload } from "./pipeline";
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
 *  1. Fetch the encrypted blob as a ReadableStream.
 *  2. Decrypt it (wrong key/password causes `decryptFromDownload` to reject —
 *     the rejection propagates directly to the caller).
 *  3. Pass the plaintext stream to `save`; return the recovered metadata.
 */
export async function downloadDecrypted(
  fetchBlob: () => Promise<ReadableStream<Uint8Array>>,
  secret: DownloadSecret,
  save: (plaintext: ReadableStream<Uint8Array>, filename: string) => Promise<void>,
): Promise<{ meta: { name: string; type: string } }> {
  const stream = await fetchBlob();
  const { meta, plaintext } = await decryptFromDownload(
    streamToAsyncIterable(stream),
    secret,
  );
  await save(asyncIterableToStream(plaintext), meta.name);
  return { meta };
}
