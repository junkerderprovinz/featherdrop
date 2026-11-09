// Fetches an encrypted blob, decrypts it and saves it. fetchBlob and save are
// injected so this runs in tests without a server or a browser download API.

import { computeKeyVerifier } from "./crypto";
import { deriveContentKey, decryptWithKey } from "./pipeline";
import { streamToAsyncIterable, asyncIterableToStream } from "./stream-adapters";
import { splitByManifest } from "./multi-file";
import { fetchResumable } from "./resumable-fetch";
import { openKeys, decryptShare, type Header } from "./v2/share";
import type { ShareKeys } from "./v2/keys";

/**
 * The server's 409: a limited share has started all its downloads, and one of
 * them can still be resumed by whoever started it.
 */
export class DownloadInProgressError extends Error {
  constructor() {
    super("download in progress");
    this.name = "DownloadInProgressError";
  }
}

/**
 * Returns a fetchBlob for the counted download GET /api/d/{slug}. The server
 * counts it as soon as it starts, and a body that breaks off resumes with the
 * token the response carries (see fetchResumable).
 */
export function fetchShareBlob(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): (keyVerifier: string) => Promise<ReadableStream<Uint8Array>> {
  return async (keyVerifier) => {
    const res = await fetchResumable(
      `/api/d/${encodeURIComponent(slug)}`,
      { headers: { "x-fd-key-verifier": keyVerifier } },
      { fetchImpl },
    );
    if (res.status === 409) throw new DownloadInProgressError();
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    return res.body;
  };
}

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
 * secret is the token from the URL fragment with the password, or the keys
 * already derived for the listing. A wrong password cannot be told apart
 * locally, so it shows up as a verifier the server refuses, before anything
 * is counted.
 */
export async function downloadDecryptedV2(
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: { token: string; password?: string } | { keys: ShareKeys },
  save: (plaintext: ReadableStream<Uint8Array>, filename: string) => Promise<void>,
): Promise<{ header: Header }> {
  const keys = "keys" in secret ? secret.keys : await openKeys(secret.token, secret.password);
  const stream = await fetchBlob(keys.verifier);
  const { header, plaintext } = await decryptShare(streamToAsyncIterable(stream), keys);
  let left = header.files.length;
  for await (const { entry, bytes } of splitByManifest(plaintext, header)) {
    const last = --left === 0;
    let read!: () => void;
    let failed!: (e: unknown) => void;
    const consumed = new Promise<void>((resolve, reject) => {
      read = resolve;
      failed = reject;
    });
    consumed.catch(() => {});
    async function* whole(): AsyncGenerator<Uint8Array> {
      let complete = false;
      try {
        yield* bytes;
        // The last file ends only after the final chunk and the padding
        // check out, so a truncated share never looks like a finished save.
        if (last) for await (const _ of plaintext) throw new Error("v2: more plaintext than the header declares");
        complete = true;
      } catch (e) {
        failed(e);
        throw e;
      } finally {
        if (complete) read();
        else failed(new Error("v2: the save stopped reading"));
      }
    }
    // save may resolve before it has read the stream, as streamToDownload
    // does, and the next file starts where this one ends.
    await save(asyncIterableToStream(whole()), entry.name);
    await consumed;
  }
  return { header };
}
