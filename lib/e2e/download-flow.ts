// Fetches an encrypted blob, decrypts it and saves it. fetchBlob and save are
// injected so this runs in tests without a server or a browser download API.

import { streamToAsyncIterable, asyncIterableToStream, watchConsumed } from "./stream-adapters";

import { splitByManifest } from "./multi-file";
import { fetchResumable } from "./resumable-fetch";
import { cipherRange, type Header } from "./v2/layout";
import { decryptInWorker, decryptRangeInWorker, decryptFileInWorker } from "./v2/remote";
import type { Client } from "./v2/protocol";
import { fetchShareHeader } from "./share-listing";
import { httpError } from "./http-error";

import { zipStream, zipLength, type ZipEntry } from "./zip";

import type { ShareKeys } from "./v2/token";

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
    if (!res.ok || !res.body) throw httpError("download", res);
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
 * Downloads a format 2 share, decrypts it in the crypto worker and saves it.
 * The key is derived before any request, so a wrong password fails without
 * the download being counted. fetchBlob gets the key verifier for the
 * `x-fd-key-verifier` header the server requires, and a tampered blob makes
 * the decrypt reject.
 */
export async function downloadDecrypted(
  crypto: Client,
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: DownloadSecret,
  save: (plaintext: ReadableStream<Uint8Array>, filename: string) => Promise<void>,
): Promise<{ meta: { name: string; type: string } }> {
  const { key, verifier } = await crypto.request({ op: "legacy-key", secret });
  const stream = await fetchBlob(verifier);
  const { meta, plaintext } = await decryptFileInWorker(crypto, key, streamToAsyncIterable(stream));
  await save(asyncIterableToStream(plaintext), meta.name);
  return { meta };
}

/**
 * Downloads a format 4 share, decrypts it in the crypto worker and saves it: a
 * single file as itself, a bundle as one ZIP named bundleName, built while it
 * decrypts. save gets the exact length for Content-Length. The secret is the token from the
 * URL fragment with the password, or the keys already derived for the
 * listing. A wrong password cannot be told apart locally, so it shows up as a
 * verifier the server refuses, before anything is counted.
 */
export async function downloadDecryptedV2(
  crypto: Client,
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: { token: string; password?: string } | { keys: ShareKeys },
  save: (plaintext: ReadableStream<Uint8Array>, filename: string, size: number) => Promise<void>,
  bundleName = "files.zip",
): Promise<{ header: Header }> {
  const { header, plaintext } = await decryptInWorker(crypto, secret, fetchBlob);

  let out: ReadableStream<Uint8Array>;
  let name: string;
  let size: number;
  if (header.kind === "single") {
    out = asyncIterableToStream(plaintext);
    [{ name, size }] = header.files;
  } else {
    async function* entries(): AsyncGenerator<ZipEntry> {
      for await (const { entry, bytes } of splitByManifest(plaintext, header)) {
        yield { name: entry.name, size: entry.size, bytes };
      }
      // The ZIP ends only after the final chunk and the padding check out, so
      // a truncated share never looks like a finished save.
      for await (const _ of plaintext) throw new Error("v2: more plaintext than the header declares");
    }
    out = zipStream(entries());
    name = bundleName;
    size = zipLength(header.files);
  }

  const { stream: watched, consumed } = watchConsumed(out);
  await save(watched, name, size);
  await consumed;
  return { header };
}

/**
 * Saves file index of a format 4 share alone. Only the chunks holding it are
 * fetched, through the uncounted ?preview=1 range read, which the server
 * allows for unlimited shares only; a limited share is one unit and downloads
 * whole. The crypto worker decrypts them.
 */
export async function downloadFileV2(
  crypto: Client,
  slug: string,
  keys: ShareKeys,
  index: number,
  save: (plaintext: ReadableStream<Uint8Array>, filename: string, size: number) => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const head = await fetchShareHeader(slug, keys.verifier, fetchImpl);
  const { header, contentOffset } = await crypto.request({ op: "header", keys, data: head });
  const file = header.files[index];
  if (!file) throw new Error(`v2: the share has no file ${index}`);
  const start = header.files.slice(0, index).reduce((sum, f) => sum + f.size, 0);
  const end = start + file.size - 1;
  const plan = cipherRange(header, contentOffset, start, end);
  if (plan === null) {
    await save(new Blob([]).stream(), file.name, 0);
    return;
  }
  const res = await fetchImpl(`/api/d/${encodeURIComponent(slug)}?preview=1`, {
    headers: { "x-fd-key-verifier": keys.verifier, Range: `bytes=${plan.from}-${plan.to}` },
  });
  if (res.status !== 206 || !res.body) throw httpError("range read", res);
  const plain = decryptRangeInWorker(crypto, keys, head, streamToAsyncIterable(res.body), start, end);
  await save(asyncIterableToStream(plain), file.name, file.size);
}
