// The page side of the crypto worker: a blob source sealed there and streams
// opened there, for format 4 and for the older formats 2 and 3. Flows get the
// Client passed in, so tests run the same protocol over a MessageChannel.

import { streamToAsyncIterable } from "../stream-adapters";
import { splitByManifest } from "../multi-file";
import { blobSource, type BlobSource, type BlobState, type FileEntry, type Header } from "./layout";
import { transferables, type Client, type LegacyOutput } from "./protocol";
import type { ShareKeys } from "./token";
import type { FileMeta } from "../crypto";
import type { MultiDownload } from "../multi-pipeline";
import type { EncryptResult } from "../pipeline";

let lastSession = 0;

/** A blob source whose chunks the worker seals from the plaintext readPlain returns. */
export function workerBlobSource(
  crypto: Client,
  state: BlobState,
  readPlain: (start: number, end: number) => Promise<Uint8Array>,
): BlobSource {
  return blobSource(state, readPlain, async (start, end, plain) => {
    const r = await crypto.request({ op: "seal", state, start, end, plain }, transferables(plain));
    return r.data;
  });
}

/**
 * Decrypts a blob in the worker. fetchBlob gets the verifier of the keys,
 * which in password mode the worker derives. The header is read and checked
 * before this resolves; the plaintext throws on any later tampering or
 * truncation.
 */
export async function decryptInWorker(
  crypto: Client,
  secret: { token: string; password?: string } | { keys: ShareKeys },
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
): Promise<{ header: Header; plaintext: AsyncGenerator<Uint8Array> }> {
  const session = ++lastSession;
  const close = () => void crypto.request({ op: "close", session });
  const { verifier } = await crypto.request({ op: "decrypt-open", session, ...secret });
  const write = (data: Uint8Array) => crypto.request({ op: "decrypt-write", session, data }, transferables(data));
  try {
    const iter = streamToAsyncIterable(await fetchBlob(verifier))[Symbol.asyncIterator]();
    const first: Uint8Array[] = [];
    let header: Header | null = null;
    while (header === null) {
      const r = await iter.next();
      if (r.done) throw new Error("v2: blob truncated in the header");
      const out = await write(r.value);
      header = out.header;
      first.push(...out.chunks);
    }
    async function* plaintext(): AsyncGenerator<Uint8Array> {
      try {
        yield* first;
        for (;;) {
          const r = await iter.next();
          if (r.done) break;
          yield* (await write(r.value)).chunks;
        }
        await crypto.request({ op: "decrypt-close", session });
      } finally {
        close();
      }
    }
    return { header, plaintext: plaintext() };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * Decrypts the inclusive plaintext range [start, end] in the worker. head is
 * the blob's first headerLength bytes, which the worker opens for itself, and
 * cipher holds the blob bytes cipherRange names for the range.
 */
export async function* decryptRangeInWorker(
  crypto: Client,
  keys: ShareKeys,
  head: Uint8Array,
  cipher: AsyncIterable<Uint8Array>,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  const session = ++lastSession;
  await crypto.request({ op: "decrypt-open", session, keys });
  try {
    await crypto.request({ op: "read-header", session, data: head });
    await crypto.request({ op: "range-open", session, start, end });
    for await (const part of cipher) {
      yield* (await crypto.request({ op: "range-write", session, data: part }, transferables(part))).chunks;
    }
    await crypto.request({ op: "range-close", session });
  } finally {
    void crypto.request({ op: "close", session });
  }
}

/**
 * Encrypts files in the worker into a format 2 share, which holds one file, or
 * a format 3 share. plaintext is the files' bytes laid end to end. The blob
 * is produced as plaintext is read from it.
 */
export async function encryptLegacyInWorker(
  crypto: Client,
  format: 2 | 3,
  files: FileEntry[],
  plaintext: AsyncIterable<Uint8Array>,
  password?: string,
): Promise<EncryptResult> {
  const session = ++lastSession;
  const secrets = await crypto.request({ op: "legacy-encrypt", session, format, files, password });
  async function* blob(): AsyncGenerator<Uint8Array> {
    try {
      for await (const part of plaintext) {
        yield* (await crypto.request({ op: "legacy-write", session, data: part }, transferables(part))).chunks;
      }
      yield* (await crypto.request({ op: "legacy-close", session })).chunks;
    } finally {
      void crypto.request({ op: "close", session });
    }
  }
  return { ...secrets, blob: blob() };
}

/**
 * Starts decrypting a format 2 or 3 blob in the worker and reads it until its
 * enc_meta is open. The plaintext throws on any later tampering or truncation.
 */
async function decryptLegacy(
  crypto: Client,
  format: 2 | 3,
  key: Uint8Array,
  ciphertext: AsyncIterable<Uint8Array>,
): Promise<{ opened: LegacyOutput; plaintext: AsyncGenerator<Uint8Array> }> {
  const session = ++lastSession;
  const close = () => void crypto.request({ op: "close", session });
  await crypto.request({ op: "legacy-decrypt", session, format, key });
  const write = (data: Uint8Array) => crypto.request({ op: "legacy-write", session, data }, transferables(data));
  try {
    const iter = ciphertext[Symbol.asyncIterator]();
    const first: Uint8Array[] = [];
    let opened: LegacyOutput | null = null;
    while (opened === null) {
      const r = await iter.next();
      if (r.done) throw new Error("blob: truncated (incomplete meta)");
      const out = await write(r.value);
      if (out.meta !== null || out.manifest !== null) opened = out;
      first.push(...out.chunks);
    }
    async function* plaintext(): AsyncGenerator<Uint8Array> {
      try {
        yield* first;
        for (;;) {
          const r = await iter.next();
          if (r.done) break;
          yield* (await write(r.value)).chunks;
        }
        yield* (await crypto.request({ op: "legacy-close", session })).chunks;
      } finally {
        close();
      }
    }
    return { opened, plaintext: plaintext() };
  } catch (err) {
    close();
    throw err;
  }
}

/** Decrypts a format 2 blob in the worker. Its meta is open before this resolves. */
export async function decryptFileInWorker(
  crypto: Client,
  key: Uint8Array,
  ciphertext: AsyncIterable<Uint8Array>,
): Promise<{ meta: FileMeta; plaintext: AsyncGenerator<Uint8Array> }> {
  const { opened, plaintext } = await decryptLegacy(crypto, 2, key, ciphertext);
  return { meta: opened.meta!, plaintext };
}

/**
 * Decrypts a format 3 blob in the worker and splits it back into its files,
 * which share one stream, so each must be drained before the next.
 */
export async function decryptBundleInWorker(
  crypto: Client,
  key: Uint8Array,
  ciphertext: AsyncIterable<Uint8Array>,
): Promise<MultiDownload> {
  const { opened, plaintext } = await decryptLegacy(crypto, 3, key, ciphertext);
  const manifest = opened.manifest!;
  return { manifest, files: splitByManifest(plaintext, manifest) };
}
