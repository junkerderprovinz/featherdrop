// Fetches an encrypted blob, decrypts it and saves it. fetchBlob and save are
// injected so this runs in tests without a server or a browser download API.

import { computeKeyVerifier } from "./crypto";
import { deriveContentKey, decryptWithKey } from "./pipeline";
import { streamToAsyncIterable, asyncIterableToStream } from "./stream-adapters";
import { splitByManifest } from "./multi-file";
import { openKeys, decryptShare, type Header } from "./v2/share";

/**
 * The decryption secret: the key from the URL fragment in link mode, or a
 * password with the wrapped key from the server in password mode.
 */
export type DownloadSecret =
  | { keyFromUrl: string }
  | { password: string; wrapped: Uint8Array; salt: Uint8Array };

/**
 * Downloads, decrypts and saves a file. The key is derived before any request,
 * so a wrong password fails without the download being counted. fetchBlob gets
 * the key verifier for the `x-fd-key-verifier` header the server requires, and
 * a tampered blob makes the decrypt reject.
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

/**
 * Downloads and decrypts a format 4 share and saves each file in turn. The
 * token comes from the URL fragment. A wrong password cannot be told apart
 * locally, so it shows up as a verifier the server refuses, before anything
 * is counted.
 */
export async function downloadDecryptedV2(
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: { token: string; password?: string },
  save: (plaintext: ReadableStream<Uint8Array>, filename: string) => Promise<void>,
): Promise<{ header: Header }> {
  const keys = await openKeys(secret.token, secret.password);
  const stream = await fetchBlob(keys.verifier);
  const { header, plaintext } = await decryptShare(streamToAsyncIterable(stream), keys);
  for await (const { entry, bytes } of splitByManifest(plaintext, header)) {
    await save(asyncIterableToStream(bytes), entry.name);
  }
  // splitByManifest stops after the last file; draining the rest checks the
  // final chunk and the padding.
  for await (const _ of plaintext) throw new Error("v2: more plaintext than the header declares");
  return { header };
}
