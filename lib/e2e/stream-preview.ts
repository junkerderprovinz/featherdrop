// Streaming inline preview of a large video through the service worker.
//
// The worker (public/sw-download.js) serves /sw-preview/<id> as the <video>
// src and asks the page for a decrypted stream per Range request. How a range
// is produced depends on the content format in enc_meta:
//
//   - cf=2 (./seekable.ts, every new share): only the chunks covering the range
//     are fetched and decrypted, so a far seek is fast.
//   - cf=1 (secretstream, older shares): the cipher is sequential, so the range
//     is decrypted from byte 0 and the prefix thrown away. Nearby seeks are
//     fast, a far seek is slow but correct.
//
// Every fetch uses ?preview=1, which the server serves uncounted and only for
// unlimited shares, so playback never uses up a limited share. Memory stays
// bounded: the chunks flow to the worker under backpressure and the whole video
// is never collected.

import { decryptWithKey, deriveContentKey, type DownloadSecret } from "./pipeline";
import { computeKeyVerifier, PT_CHUNK } from "./crypto";
import { streamToAsyncIterable, asyncIterableToStream } from "./stream-adapters";
import {
  chunkByteRange,
  chunksForPlaintextRange,
  cipherLengthForSize,
  decryptSeekableRange,
} from "./seekable";

// Per-frame secretstream overhead: the auth tag plus the tag byte.
const ABYTES = 17;
// Upper bound on [varint(metaLen)][enc_meta][secretstream header]. enc_meta is
// a small secretbox, so 8 KiB covers even a very long file name. Guessing high
// only fetches a few extra bytes; guessing low would break the decrypt.
const PREFIX_BYTES_UPPER_BOUND = 8192;
const CIPHER_FRAME = PT_CHUNK + ABYTES;

/**
 * Reports whether the streaming preview can run: a secure context with service
 * workers. The caller also checks for a video above the in-memory cap.
 */
export function canStreamPreview(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    "serviceWorker" in navigator
  );
}

// Registers the same worker file as the download path.
let _swReady: Promise<ServiceWorkerRegistration> | null = null;

function ensureSwRegistered(): Promise<ServiceWorkerRegistration> {
  if (_swReady) return _swReady;
  _swReady = navigator.serviceWorker
    .register("/sw-download.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch((err: unknown) => {
      // A cached rejection would break every later preview in this session.
      _swReady = null;
      throw err;
    });
  return _swReady;
}

/** A live preview registration; call release() when the <video> goes away. */
export interface PreviewHandle {
  /** The URL for <video src>. */
  url: string;
  /** Tells the worker to forget the id and closes the page's port. */
  release: () => void;
}

/**
 * Produces a fresh decrypted stream of exactly the plaintext in the inclusive
 * range [start, end]; the worker clamps end to size-1.
 */
type RangeStreamFactory = (
  start: number,
  end: number,
) => Promise<ReadableStream<Uint8Array>>;

/**
 * The last ciphertext offset to fetch for decrypting a cf=1 blob through
 * plaintextEnd, or null for the whole file. The prefix is overestimated, so it
 * errs toward fetching more. A range that reaches the last frame returns null,
 * because that frame's length cannot be bounded exactly and the decrypt needs
 * all of it to check TAG_FINAL.
 */
export function cipherPrefixEnd(
  plaintextEnd: number,
  plaintextSize: number,
  ciphertextSize: number,
): number | null {
  const lastFrameStart = Math.floor((plaintextSize - 1) / PT_CHUNK) * PT_CHUNK;
  if (plaintextEnd >= lastFrameStart) return null;
  const frame = Math.floor(plaintextEnd / PT_CHUNK);
  // One frame of slack on top of the overestimated prefix.
  const end =
    PREFIX_BYTES_UPPER_BOUND + (frame + 2) * CIPHER_FRAME - 1;
  if (end >= ciphertextSize - 1) return null;
  return end;
}

/**
 * Range factory for a cf=1 video: fetch the ciphertext prefix the range needs,
 * decrypt from 0, drop the bytes before start and stop after end. The key is
 * derived once by the caller, so a far seek never reruns Argon2id.
 */
function makeFormat2RangeFactory(
  downloadUrl: string,
  key: Uint8Array,
  plaintextSize: number,
  ciphertextSize: number,
): RangeStreamFactory {
  const previewUrl = `${downloadUrl}?preview=1`;
  return async (start, end) => {
    const cEnd = cipherPrefixEnd(end, plaintextSize, ciphertextSize);
    const headers: Record<string, string> = {
      "x-fd-key-verifier": computeKeyVerifier(key),
    };
    if (cEnd !== null) headers["Range"] = `bytes=0-${cEnd}`;
    const res = await fetch(previewUrl, { headers });
    // A ranged 206 and a whole-file 200 both work.
    if (!res.ok || !res.body) throw new Error(`preview fetch ${res.status}`);
    const { plaintext } = await decryptWithKey(
      streamToAsyncIterable(res.body as ReadableStream<Uint8Array>),
      key,
    );
    return asyncIterableToStream(sliceRange(plaintext, start, end));
  };
}

/**
 * Range factory for a cf=2 video: fetch only the chunks covering the range and
 * decrypt them independently. decryptSeekableRange works in content-relative
 * offsets; this fetch adds contentOffset, where the content starts after
 * enc_meta, to build the absolute Range request.
 */
function makeFormat2SeekRangeFactory(
  downloadUrl: string,
  key: Uint8Array,
  baseNonce: Uint8Array,
  plaintextSize: number,
  contentOffset: number,
): RangeStreamFactory {
  const previewUrl = `${downloadUrl}?preview=1`;
  const verifier = computeKeyVerifier(key);
  const fetchCipherRange = async (
    cStart: number,
    cEnd: number,
  ): Promise<Uint8Array> => {
    const absStart = contentOffset + cStart;
    const absEnd = contentOffset + cEnd;
    const res = await fetch(previewUrl, {
      headers: {
        "x-fd-key-verifier": verifier,
        Range: `bytes=${absStart}-${absEnd}`,
      },
    });
    if (!res.ok || !res.body) throw new Error(`preview fetch ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf;
  };
  return async (start, end) =>
    asyncIterableToStream(
      decryptSeekableRange(
        fetchCipherRange,
        key,
        baseNonce,
        plaintextSize,
        start,
        end,
      ),
    );
}

/**
 * The absolute inclusive blob range a cf=2 preview fetches for the plaintext
 * range, or null when the range is empty. It is the same math the seek factory
 * uses, exported for tests.
 */
export function seekCipherByteRange(
  plaintextStart: number,
  plaintextEnd: number,
  size: number,
  contentOffset: number,
): { start: number; end: number } | null {
  if (size <= 0) return null;
  const start = Math.max(0, plaintextStart);
  const end = Math.min(size - 1, plaintextEnd);
  if (end < start) return null;
  const { first, last } = chunksForPlaintextRange(start, end);
  const cipherRegionLen = cipherLengthForSize(size);
  const firstByte = chunkByteRange(first).start;
  const lastByte = Math.min(chunkByteRange(last).end, cipherRegionLen - 1);
  return { start: contentOffset + firstByte, end: contentOffset + lastByte };
}

/**
 * Yields the bytes of the inclusive range [start, end] from a sequential
 * source without buffering. Earlier bytes are dropped as they arrive, and the
 * break after end returns the source iterator, which cancels upstream.
 */
export async function* sliceRange(
  source: AsyncIterable<Uint8Array>,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  const wanted = end - start + 1;
  if (wanted <= 0) return;
  let pos = 0;
  let emitted = 0;
  for await (const chunk of source) {
    if (emitted >= wanted) break;
    const chunkStart = pos;
    const chunkEnd = pos + chunk.length;
    pos = chunkEnd;
    if (chunkEnd <= start) continue;
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(chunk.length, end + 1 - chunkStart);
    if (to <= from) continue;
    const piece =
      from === 0 && to === chunk.length ? chunk : chunk.subarray(from, to);
    emitted += piece.length;
    yield piece;
  }
}

/**
 * Resolves once the service worker controls this page. The worker claims
 * clients on activate, which fires controllerchange; after timeoutMs this
 * rejects so a page that is never controlled falls back to no preview.
 */
function waitForController(timeoutMs: number): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
    const onChange = () => {
      if (navigator.serviceWorker.controller) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("service worker did not take control in time"));
    }, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    // Control may have arrived before the listener was added.
    onChange();
  });
}

/**
 * Registers a streaming video preview with the service worker and returns the
 * <video> URL and a release function. The caller has already checked for a
 * secure context, format 2, a video above the in-memory cap and an unlimited
 * share.
 */
export async function registerVideoPreview(opts: {
  downloadUrl: string;
  secret: DownloadSecret;
  mime: string;
  /**
   * Plaintext length from the encrypted meta. All Range math uses it, so it
   * must not be the ciphertext size the server sees.
   */
  size: number;
  /** Ciphertext length on disk; bounds the cf=1 prefix fetch. */
  ciphertextSize: number;
  /** Content format from enc_meta; cf=2 also needs baseNonce and contentOffset. */
  cf?: 1 | 2;
  /** cf=2 base nonce from enc_meta. */
  baseNonce?: Uint8Array;
  /** cf=2 blob offset where the content starts, after enc_meta. */
  contentOffset?: number;
}): Promise<PreviewHandle> {
  await ensureSwRegistered();
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("Service worker active worker not found");

  // The worker only intercepts /sw-preview/<id> once it controls the page. On a
  // first visit its claim can land just after serviceWorker.ready resolves, so
  // wait for it; the timeout leaves the download button for a page that never
  // gets controlled.
  if (!navigator.serviceWorker.controller) {
    await waitForController(4000);
  }

  const key = await deriveContentKey(opts.secret);
  const factory =
    opts.cf === 2 && opts.baseNonce && typeof opts.contentOffset === "number"
      ? makeFormat2SeekRangeFactory(
          opts.downloadUrl,
          key,
          opts.baseNonce,
          opts.size,
          opts.contentOffset,
        )
      : makeFormat2RangeFactory(
          opts.downloadUrl,
          key,
          opts.size,
          opts.ciphertextSize,
        );

  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(36).slice(2);

  // The worker keeps port2 and forwards every range request over it, each with
  // its own reply port for the produced stream.
  const channel = new MessageChannel();
  channel.port1.onmessage = (ev: MessageEvent) => {
    const { start, end } = (ev.data ?? {}) as { start?: number; end?: number };
    const reply = ev.ports[0];
    if (!reply) return;
    if (typeof start !== "number" || typeof end !== "number") {
      reply.postMessage({ error: "bad range" });
      reply.close();
      return;
    }
    void factory(start, end)
      .then((stream) => {
        reply.postMessage({ stream }, [stream as unknown as Transferable]);
        reply.close();
      })
      .catch((e: unknown) => {
        reply.postMessage({ error: e instanceof Error ? e.message : String(e) });
        reply.close();
      });
  };
  channel.port1.start?.();

  sw.postMessage(
    {
      type: "fd-preview-register",
      id,
      port: channel.port2,
      mime: opts.mime,
      size: opts.size,
    },
    [channel.port2],
  );

  return {
    url: `/sw-preview/${id}`,
    release: () => {
      try {
        sw.postMessage({ type: "fd-preview-release", id });
      } catch {
        /* worker gone, nothing to release */
      }
      try {
        channel.port1.close();
      } catch {
        /* already closed */
      }
    },
  };
}
