// Browser-only STREAMING inline preview of a large video via the service worker.
//
// The download SW (public/sw-download.js) also serves a /sw-preview/<id> URL that
// a <video> element can use as its src. Because the zero-knowledge cipher is a
// SEQUENTIAL libsodium secretstream, the plaintext at byte offset X can only be
// produced by decrypting from 0 and discarding the first X bytes — there is no
// random access. So:
//   - Progressive play from the start is fast.
//   - Seeking within the already-played / buffered region is fast (the browser
//     serves it from its own media buffer, no new request).
//   - A FAR-FORWARD seek issues a Range request for a high offset, which we honor
//     by RE-DECRYPTING from 0 and skipping to that offset. It is correct but slow
//     (and re-fetches the ciphertext). This is the documented, accepted trade-off.
//
// Count-safety: every range fetch hits the server's NO-COUNT ?preview=1 path,
// which requires the key-verifier but does not call registerDownload and is
// allowed ONLY for UNLIMITED shares (the server enforces unlimited-only; the
// caller also gates client-side). So a playback's several GETs never burn or
// count a download-limited / burn-after-download share.
//
// Bandwidth: instead of re-downloading the WHOLE ciphertext per range, each
// request fetches only the ciphertext PREFIX needed to decrypt plaintext through
// the requested `end` (a Range request against the encrypted blob). A near-start
// range fetches little; a tail seek still needs the whole prefix (the cipher is
// sequential) but never more than the file.
//
// Memory stays BOUNDED: nothing collects the whole video. Each requested range is
// produced by a streaming pipeline (fetch → decrypt → skip → slice) whose chunks
// flow straight to the SW under backpressure; the skipped prefix is discarded as
// it is decrypted, never accumulated.

import { decryptWithKey, deriveContentKey, type DownloadSecret } from "./pipeline";
import { computeKeyVerifier, PT_CHUNK } from "./crypto";
import { streamToAsyncIterable, asyncIterableToStream } from "./stream-adapters";

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
 * Register a streaming video preview with the service worker and return a URL to
 * put in <video src> plus a release() cleanup. Derives the content key once and
 * answers every SW range request by re-decrypting from 0 and slicing.
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
   * only to bound the ciphertext-prefix Range fetch (and to know when to fetch
   * through EOF). Never used for plaintext Range math.
   */
  ciphertextSize: number;
}): Promise<PreviewHandle> {
  await ensureSwRegistered();
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("Service worker active worker not found");

  // The <video> src (/sw-preview/<id>) is a plain navigation/sub-resource fetch:
  // it is only intercepted when the SW already CONTROLS this page. On a brand-new
  // first visit the SW activates + claims, but a page loaded before activation may
  // not be controlled until a reload — in that case the fetch would NOT be
  // intercepted and the <video> would fail. Bail here so the caller falls back to
  // today's behavior (no preview, just the download button) instead of showing a
  // broken player. (The download path is unaffected: it uses a freshly-navigated
  // iframe, which the just-activated SW does intercept.)
  if (!navigator.serviceWorker.controller) {
    throw new Error("service worker does not control this page yet");
  }

  // Derive the key once — a far seek re-decrypts from 0 but never re-derives.
  const key = await deriveContentKey(opts.secret);
  const factory = makeFormat2RangeFactory(
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
