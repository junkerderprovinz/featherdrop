// The page side of the crypto worker: a blob source sealed there and streams
// opened there. Flows get the Client passed in, so tests run the same
// protocol over a MessageChannel.

import { streamToAsyncIterable } from "../stream-adapters";
import { blobSource, type BlobSource, type BlobState, type Header } from "./share";
import { transferables, type Client } from "./protocol";
import type { ShareKeys } from "./keys";

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
