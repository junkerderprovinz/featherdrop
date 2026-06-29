// Browser-only STREAMING inline preview of a large video via the service worker.
//
// The download SW (public/sw-download.js) serves a /sw-preview/<id> URL that a
// <video> element uses as its src, asking the page for a fresh decrypted stream
// per Range request. How a range is produced depends on the share's content
// format (read from the decrypted enc_meta):
//
//   - cf=2 (per-chunk AEAD, ./seekable.ts — the encoding for ALL NEW shares):
//     TRUE random access. For a plaintext range [a, b] we fetch and decrypt ONLY
//     the COVERING chunks (floor(a/PT_CHUNK)..floor(b/PT_CHUNK)) — mapping their
//     content-relative cipher span to ABSOLUTE blob bytes via the contentOffset —
//     so a far-forward seek into a large video is fast and fetches little. See
//     makeFormat2SeekRangeFactory.
//   - cf=1 (legacy libsodium secretstream): the cipher is SEQUENTIAL, so the
//     plaintext at offset X can only be produced by decrypting from 0 and
//     discarding the first X bytes — no random access. We fetch the ciphertext
//     PREFIX needed through the requested `end` and slice. Progressive play and
//     nearby seeks are fast; a far seek re-decrypts from 0 (correct but slow).
//     This is the documented, accepted trade-off, kept for old shares. See
//     makeFormat2RangeFactory.
//
// Count-safety: every range fetch hits the server's NO-COUNT ?preview=1 path,
// which requires the key-verifier but does not call registerDownload and is
// allowed ONLY for UNLIMITED shares (the server enforces unlimited-only; the
// caller also gates client-side). So a playback's several GETs never burn or
// count a download-limited / burn-after-download share.
//
// Memory stays BOUNDED: nothing collects the whole video. Each requested range is
// produced by a streaming pipeline whose chunks flow straight to the SW under
// backpressure; for cf=1 the skipped prefix is discarded as it is decrypted, and
// for cf=2 only the covering chunks are ever in flight — never the whole file.

import { decryptWithKey, deriveContentKey, type DownloadSecret } from "./pipeline";
import { computeKeyVerifier, PT_CHUNK } from "./crypto";
import { streamToAsyncIterable, asyncIterableToStream } from "./stream-adapters";
import {
  chunkByteRange,
  chunksForPlaintextRange,
  cipherLengthForSize,
  decryptSeekableRange,
} from "./seekable";

// secretstream/xchacha20poly1305 framing constants (fixed by the algorithm):
//   ABYTES      — per-frame ciphertext overhead (auth tag + tag byte) = 17.
//   HEADERBYTES — the secretstream header that precedes the frames     = 24.
// One ciphertext frame is PT_CHUNK + ABYTES bytes (the final frame is shorter).
const ABYTES = 17;
// Generous upper bound on the [varint(metaLen)][enc_meta][secretstream header]
// prefix region that precedes the frames. enc_meta is a small secretbox of
// {name,type,size} JSON; 8 KiB comfortably covers even a very long filename, and
// over-estimating only fetches a few extra (harmless) bytes — under-estimating
// would corrupt the decrypt, so we err high.
const PREFIX_BYTES_UPPER_BOUND = 8192;
const CIPHER_FRAME = PT_CHUNK + ABYTES;

/**
 * Whether the streaming-preview path is available: a secure context with an
 * active service worker. (The caller additionally checks kind === "video" and
 * size > the in-memory blob cap before using it.)
 */
export function canStreamPreview(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    "serviceWorker" in navigator
  );
}

// Module-level registration promise so we only call register() once. Shares the
// same worker file as the download path (idempotent registration).
let _swReady: Promise<ServiceWorkerRegistration> | null = null;

function ensureSwRegistered(): Promise<ServiceWorkerRegistration> {
  if (_swReady) return _swReady;
  _swReady = navigator.serviceWorker
    .register("/sw-download.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch((err: unknown) => {
      // Don't cache a rejection — a transient failure must not poison every
      // later call this session.
      _swReady = null;
      throw err;
    });
  return _swReady;
}

/** A live preview registration; call release() when the <video> goes away. */
export interface PreviewHandle {
  /** The URL to put in <video src>. */
  url: string;
  /** Tear down: tell the SW to forget the id and stop the page-side port. */
  release: () => void;
}

/**
 * How a range is produced. Given a half-open-ish [start, end] (both inclusive,
 * end clamped to size-1 by the SW), returns a fresh decrypted ReadableStream that
 * yields exactly the plaintext bytes for that range, in order.
 */
type RangeStreamFactory = (
  start: number,
  end: number,
) => Promise<ReadableStream<Uint8Array>>;

/**
 * The LAST ciphertext byte offset that must be fetched to decrypt plaintext
 * through `plaintextEnd`, or null meaning "fetch the whole ciphertext".
 *
 * The cipher is sequential: plaintext byte `plaintextEnd` lives in frame
 * f = floor(plaintextEnd / PT_CHUNK), so we need every ciphertext byte up to the
 * END of frame f: PREFIX + (f+1)*CIPHER_FRAME (with the prefix over-estimated, so
 * we err toward fetching slightly MORE — never less, which would corrupt decrypt).
 *
 * Returns null (= whole file) when the requested range reaches the LAST plaintext
 * frame: there the prefix math can't bound the (shorter) final frame precisely,
 * and decryptChunks REQUIRES the complete final frame (TAG_FINAL) once sliceRange
 * drains to the end — so we fetch through EOF to guarantee it is present. Pure +
 * exported for unit testing.
 */
export function cipherPrefixEnd(
  plaintextEnd: number,
  plaintextSize: number,
  ciphertextSize: number,
): number | null {
  // In (or past) the last plaintext frame → fetch the whole ciphertext so the
  // final TAG_FINAL frame is always complete.
  const lastFrameStart = Math.floor((plaintextSize - 1) / PT_CHUNK) * PT_CHUNK;
  if (plaintextEnd >= lastFrameStart) return null;
  const frame = Math.floor(plaintextEnd / PT_CHUNK);
  // +1 extra frame of slack on top of the over-estimated prefix, then clamp.
  const end =
    PREFIX_BYTES_UPPER_BOUND + (frame + 2) * CIPHER_FRAME - 1;
  if (end >= ciphertextSize - 1) return null; // would reach EOF anyway
  return end;
}

/**
 * Build a RangeStreamFactory for a single-file (format 2) zero-knowledge video.
 *
 * Each call:
 *   1. Fetches the ciphertext PREFIX needed for this range via ?preview=1 (a
 *      NO-COUNT, Range-capable GET — unlimited shares only, enforced server-side;
 *      see canStreamPreview's doc). The key-verifier header is sent so the server
 *      accepts it. Fetching only the prefix avoids re-downloading the whole file
 *      per Range/seek.
 *   2. Decrypts sequentially from offset 0.
 *   3. Skips the first `start` plaintext bytes (discarding them as they decrypt).
 *   4. Emits bytes until `end` (inclusive), then stops and cancels the upstream.
 *
 * The key is derived ONCE (so a far seek doesn't re-run Argon2id) and captured.
 */
function makeFormat2RangeFactory(
  downloadUrl: string,
  key: Uint8Array,
  plaintextSize: number,
  ciphertextSize: number,
): RangeStreamFactory {
  const previewUrl = `${downloadUrl}?preview=1`;
  return async (start, end) => {
    // Compute the ciphertext prefix [0, cEnd] we must fetch (or the whole file).
    const cEnd = cipherPrefixEnd(end, plaintextSize, ciphertextSize);
    const headers: Record<string, string> = {
      "x-fd-key-verifier": computeKeyVerifier(key),
    };
    if (cEnd !== null) headers["Range"] = `bytes=0-${cEnd}`;
    const res = await fetch(previewUrl, { headers });
    // 206 (ranged prefix) or 200 (whole file) are both fine; anything else fails.
    if (!res.ok || !res.body) throw new Error(`preview fetch ${res.status}`);
    const { plaintext } = await decryptWithKey(
      streamToAsyncIterable(res.body as ReadableStream<Uint8Array>),
      key,
    );
    return asyncIterableToStream(sliceRange(plaintext, start, end));
  };
}

/**
 * Build a RangeStreamFactory for a cf=2 SEEKABLE single-file video — TRUE random
 * access. For a requested PLAINTEXT range [start, end] it:
 *   1. Finds the covering chunks (chunksForPlaintextRange).
 *   2. Maps them to their CONTENT-relative cipher byte span (chunkByteRange,
 *      clamped to the cf=2 cipher region length cipherLengthForSize(size)).
 *   3. Adds `contentOffset` — the absolute blob offset where the content region
 *      begins, i.e. just after [varint(metaLen)][enc_meta] — to get the ABSOLUTE
 *      blob bytes, and fetches ONLY those via ?preview=1 + an HTTP Range request.
 *   4. Decrypts those chunks independently (decryptSeekableRange) and yields
 *      exactly plaintext[start, end].
 *
 * This replaces the cf=1 "re-fetch whole ciphertext + decrypt from 0" with a
 * single covering-chunk fetch, so a far seek into a large video fetches and
 * decrypts only its tail chunks. The key + baseNonce are captured once.
 *
 * The injected fetch maps a CONTENT-relative inclusive cipher span to an absolute
 * Range request; decryptSeekableRange does all the chunk math against the content
 * region (offsets 0..cipherLen-1), so the +contentOffset translation lives only
 * here.
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
  // Fetch a CONTENT-relative inclusive cipher span [cStart, cEnd] → its absolute
  // blob bytes via an HTTP Range. Only the covering chunks' bytes are requested.
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
 * The ABSOLUTE blob byte span [start, end] (inclusive) that a cf=2 seekable
 * preview fetches to serve plaintext [plaintextStart, plaintextEnd]. Pure +
 * exported for unit testing the plaintext→ciphertext mapping (the same math
 * makeFormat2SeekRangeFactory's fetch uses). Returns null when the requested
 * range is empty (nothing to fetch). `contentOffset` is where the content region
 * begins (after [varint(metaLen)][enc_meta]).
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
 * Yield exactly the plaintext bytes for the inclusive byte range [start, end]
 * from a SEQUENTIAL source, WITHOUT buffering: bytes before `start` are discarded
 * as they arrive and emission stops once `end` is reached (the source's iterator
 * is then `return()`-ed by the `for await ... break`, cancelling upstream). Pure
 * (no DOM/network), so the range math is unit-testable. `start`/`end` are 0-based
 * and inclusive; callers clamp `end` to size-1.
 */
export async function* sliceRange(
  source: AsyncIterable<Uint8Array>,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  const wanted = end - start + 1;
  if (wanted <= 0) return;
  let pos = 0; // plaintext bytes seen so far
  let emitted = 0;
  for await (const chunk of source) {
    if (emitted >= wanted) break;
    const chunkStart = pos;
    const chunkEnd = pos + chunk.length; // exclusive
    pos = chunkEnd;
    // Entirely before the window — discard.
    if (chunkEnd <= start) continue;
    // Overlap of [start, end+1) with [chunkStart, chunkEnd).
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
 * Resolve once the service worker CONTROLS this page (navigator.serviceWorker
 * .controller is set). The SW's activate handler calls clients.claim(), which
 * fires `controllerchange` on a page that was loaded before activation; we listen
 * for that. Rejects after timeoutMs so a page that never gets controlled (e.g. SW
 * registration blocked) degrades to no-preview instead of hanging.
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
    // Re-check: control may have been taken between the initial check and the
    // listener registration.
    onChange();
  });
}

/**
 * Register a streaming video preview with the service worker and return a URL to
 * put in <video src> plus a release() cleanup. Derives the content key once and
 * answers every SW range request via a per-range factory:
 *   - cf=2 (seekable): TRUE random access — each range fetches and decrypts ONLY
 *     the covering chunks (makeFormat2SeekRangeFactory). Requires baseNonce +
 *     contentOffset so plaintext offsets map to absolute ciphertext blob bytes.
 *   - cf=1 / absent (secretstream): today's behavior — re-decrypt the ciphertext
 *     prefix from 0 and slice (makeFormat2RangeFactory). A far seek is slow but
 *     correct. This keeps old shares working unchanged.
 *
 * Caller MUST have already verified: secure context + SW (canStreamPreview),
 * format 2, kind === "video", size > the in-memory blob cap, and an UNLIMITED
 * share. This function does the SW plumbing only.
 */
export async function registerVideoPreview(opts: {
  downloadUrl: string;
  secret: DownloadSecret;
  mime: string;
  /**
   * Exact PLAINTEXT byte length of the video — read from the encrypted meta
   * (meta.size). Drives ALL Range math (Content-Length / Content-Range / 416)
   * AND the plaintext slicing, so it MUST be the plaintext length, NOT the
   * server-visible ciphertext size.
   */
  size: number;
  /**
   * On-disk CIPHERTEXT byte length (= the `size` DB column / `rec.size`). Used
   * only to bound the cf=1 ciphertext-prefix Range fetch (and to know when to
   * fetch through EOF). Never used for plaintext Range math, and unused for cf=2.
   */
  ciphertextSize: number;
  /**
   * Content-format from the decrypted enc_meta. 2 → use the seekable chunk-range
   * factory; absent/1 → the legacy from-0 secretstream factory. The cf=2 factory
   * additionally needs `baseNonce` + `contentOffset` (below).
   */
  cf?: 1 | 2;
  /**
   * cf=2 only: the per-file 24-byte base nonce (from the decrypted enc_meta),
   * needed to derive each chunk's nonce for independent decryption.
   */
  baseNonce?: Uint8Array;
  /**
   * cf=2 only: absolute blob offset where the content region begins — just after
   * [varint(metaLen)][enc_meta]. Added to a chunk's content-relative cipher range
   * to get the absolute blob bytes to Range-fetch.
   */
  contentOffset?: number;
}): Promise<PreviewHandle> {
  await ensureSwRegistered();
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("Service worker active worker not found");

  // The <video> src (/sw-preview/<id>) is only intercepted once the SW CONTROLS
  // this page. The SW calls clients.claim() on activate, which takes control even
  // of a page that was loaded before activation — but on a brand-new FIRST visit
  // that claim can land just AFTER navigator.serviceWorker.ready resolves, so
  // `controller` is briefly null. Previously we bailed here, which meant the video
  // preview never appeared on the first visit and only worked after a manual
  // reload. Instead, WAIT for the SW to take control (clients.claim() fires a
  // `controllerchange`), with a short timeout so a genuinely uncontrolled page
  // still degrades to the download button rather than a broken player.
  if (!navigator.serviceWorker.controller) {
    await waitForController(4000);
  }

  // Derive the key once — a (cf=1) far seek re-decrypts from 0 but never
  // re-derives; the cf=2 factory captures it for per-chunk decryption.
  const key = await deriveContentKey(opts.secret);
  const factory =
    opts.cf === 2 && opts.baseNonce && typeof opts.contentOffset === "number"
      ? makeFormat2SeekRangeFactory(
          opts.downloadUrl,
          key,
          opts.baseNonce, // per-file base nonce → derives each chunk's nonce
          opts.size, // plaintext length — authenticated size + range clamp
          opts.contentOffset, // plaintext→absolute-ciphertext-byte translation
        )
      : makeFormat2RangeFactory(
          opts.downloadUrl,
          key,
          opts.size, // plaintext length — drives slicing + prefix frame math
          opts.ciphertextSize, // ciphertext length — bounds the prefix Range fetch
        );

  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(36).slice(2);

  // Long-lived channel: the SW keeps port2; the page keeps port1 and answers
  // every range request the SW forwards. Each request carries its own reply port
  // (transferred by the SW) over which we send the produced stream back.
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
        // Transfer the ReadableStream to the SW; it's a Transferable.
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
        /* SW gone — nothing to release */
      }
      try {
        channel.port1.close();
      } catch {
        /* already closed */
      }
    },
  };
}
