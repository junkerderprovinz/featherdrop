// Service worker for streaming downloads — the Firefox-Send / StreamSaver pattern.
// Installed at /sw-download.js (scope /). The main thread transfers a ReadableStream
// via postMessage and then navigates a hidden <iframe> to /sw-download/<id>; the SW
// intercepts that fetch and responds with the stream directly, so the browser saves
// decrypted bytes without ever buffering the whole file in JS heap RAM.
//
// The SAME worker also powers streaming INLINE PREVIEW of large videos via a
// SEPARATE /sw-preview/<id> URL (see the preview section near the bottom). The
// download path below is intentionally left byte-for-byte unchanged.

/** @type {Map<string, {stream: ReadableStream<Uint8Array>, filename: string, size?: number}>} */
const pending = new Map();

self.addEventListener("install", (event) => {
  // Take over immediately — don't wait for the old SW to release clients.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Claim all open windows in this scope so the very first fetch is intercepted.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
  // Preview registration is a tagged message; route it to the preview handler and
  // return so the download branch below stays exactly as it was.
  if (data.type === "fd-preview-register") {
    registerPreview(data);
    return;
  }
  if (data.type === "fd-preview-release") {
    preview.delete(data.id);
    return;
  }
  const { id, stream, filename, size } = data;
  if (typeof id === "string" && stream instanceof ReadableStream) {
    pending.set(id, { stream, filename: filename ?? "download", size });
    // Best-effort eviction so a stream for a download that never starts (tab
    // closed before the iframe fetch) doesn't pin its resource chain forever.
    setTimeout(() => pending.delete(id), 60_000);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // PWA share target: Android's share sheet POSTs the shared files to
  // /share-target (see manifest.webmanifest). Stash them in a Cache and bounce
  // to the app, which picks them up via lib/share-target.ts. Checked first but
  // only matches its own POST path — downloads/previews are untouched, and any
  // failure still lands the user on the normal page.
  if (url.pathname === "/share-target" && event.request.method === "POST") {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Preview interception is checked FIRST and only matches its own /sw-preview/
  // path, so the download matcher below is reached for exactly the same requests
  // as before — the download behavior is unchanged.
  const pm = url.pathname.match(/^\/sw-preview\/([^/]+)$/);
  if (pm) {
    handlePreviewFetch(event, pm[1]);
    return;
  }

  // Match /sw-download/<id>
  const m = url.pathname.match(/^\/sw-download\/([^/]+)$/);
  if (!m) return; // fall through — not our URL

  const id = m[1];
  const entry = pending.get(id);
  if (!entry) return; // unknown id — fall through (browser will 404 the iframe)

  // Consume entry immediately so it's only delivered once.
  pending.delete(id);

  const { stream, filename, size } = entry;
  // RFC 5987 extended name for modern UAs + an ASCII fallback for old ones.
  const encodedName = encodeURIComponent(filename).replace(/'/g, "%27");
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");

  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
  };
  // `size` must be the exact PLAINTEXT byte length — a mismatched
  // Content-Length makes Chromium mark the download as failed. Callers that
  // don't know it (e.g. encrypted shares, where only the ciphertext size is
  // known) omit it, and we simply send no Content-Length.
  if (Number.isFinite(size) && size >= 0) {
    headers["Content-Length"] = String(size);
  }

  event.respondWith(new Response(stream, { status: 200, headers }));
});

// ───────────────────────────────────────────────────────────────────────────
// Streaming INLINE PREVIEW (large videos) — /sw-preview/<id>
//
// A <video src="/sw-preview/<id>"> must be able to start playing a video that is
// too large to buffer into a blob: URL. The plaintext is produced on the MAIN
// THREAD (the WASM/crypto lives there, not in this worker), so this worker does
// NOT decrypt. Instead it asks the controlling page, per request, for a FRESH
// decrypted ReadableStream of exactly the requested byte range, and pipes it
// straight to the <video> element. Memory stays bounded: bytes flow through,
// nothing is collected here. This worker is FORMAT-AGNOSTIC — it only forwards
// [start, end] to the page and streams back whatever the page produces.
//
// Range handling: <video> issues HTTP Range requests. How the page produces the
// range depends on the share's content format (the page knows it, this worker
// does not):
//   - cf=2 (seekable per-chunk AEAD, all NEW shares): TRUE random access — the
//     page fetches and decrypts ONLY the covering chunks, so a far seek is fast.
//   - cf=1 (legacy secretstream): the cipher is sequential, so the page produces
//     plaintext at offset X by decrypting from 0 and discarding the first X bytes
//     — a far seek is slow but correct; progressive play / nearby seeks are fast.
// Either way we honor Range by telling the page the desired [start, end] and
// replying 206 with a correct Content-Range. A plain (no-Range) request is
// answered 200 with Accept-Ranges: bytes and the full Content-Length.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Active preview registrations: id -> { port, mime, size }. Unlike `pending`
 * (consumed on first fetch), a preview entry PERSISTS so the <video> can make
 * many Range requests against it. Evicted on an explicit release message or a
 * timeout.
 * @type {Map<string, {port: MessagePort, mime: string, size: number}>}
 */
const preview = new Map();

/** Store a preview registration sent from the page. */
function registerPreview(data) {
  const { id, port, mime, size } = data;
  if (typeof id !== "string" || !(port instanceof MessagePort)) return;
  if (!Number.isFinite(size) || size < 0) return;
  preview.set(id, {
    port,
    mime: typeof mime === "string" && mime ? mime : "application/octet-stream",
    size,
  });
  // Belt-and-suspenders eviction: a preview that is never released (tab closed)
  // must not pin the page's port forever. 30 min is comfortably longer than any
  // realistic single playback session; the page also releases on unmount.
  setTimeout(() => preview.delete(id), 30 * 60_000);
}

/**
 * Ask the controlling page for a fresh decrypted stream for [start, end] and
 * resolve to it. The page decrypts from 0 and skips to `start`, then yields
 * bytes up to and including `end`. Rejects if the page reports an error.
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
function requestPreviewStream(entry, start, end) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("preview stream request timed out"));
    }, 60_000);
    channel.port1.onmessage = (ev) => {
      clearTimeout(timer);
      const msg = ev.data ?? {};
      if (msg.stream instanceof ReadableStream) {
        resolve(msg.stream);
      } else {
        reject(new Error(msg.error ? String(msg.error) : "preview stream failed"));
      }
      channel.port1.close();
    };
    // The reply port (port2) is transferred to the page; the page transfers the
    // ReadableStream back over it.
    entry.port.postMessage({ start, end }, [channel.port2]);
  });
}

/** Parse a single-range "bytes=start-end" header against `size`. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  let start;
  let end;
  if (hasStart) {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
  } else if (hasEnd) {
    // suffix range: last N bytes.
    const n = parseInt(m[2], 10);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    return null;
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

/** Respond to a /sw-preview/<id> fetch. */
function handlePreviewFetch(event, id) {
  const entry = preview.get(id);
  if (!entry) return; // unknown id — fall through (browser will 404 / retry)

  const { mime, size } = entry;
  const rangeHeader = event.request.headers.get("range");
  const range = parseRange(rangeHeader, size);

  if (range && range.unsatisfiable) {
    event.respondWith(
      new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      }),
    );
    return;
  }

  const start = range ? range.start : 0;
  let end = range ? range.end : size - 1;

  // Cap how much a single response serves. A <video> opens playback with an
  // open-ended "bytes=0-" request; without a cap that asks the page to fetch +
  // decrypt the WHOLE file before the first frame ("lädt sehr lange"). Serve a
  // bounded window instead and let the element re-request later windows via Range
  // as it plays/seeks — standard chunked range streaming, fast first byte, bounded
  // memory. Any clamped response MUST be a 206 with Content-Range (it is partial).
  const MAX_WINDOW = 4 * 1024 * 1024; // 4 MiB per response
  let clamped = false;
  if (end - start + 1 > MAX_WINDOW) {
    end = start + MAX_WINDOW - 1;
    clamped = true;
  }
  const length = end - start + 1;
  const partial = Boolean(range) || clamped;

  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
    // Never let a preview response be sniffed into a scriptable type, and never
    // cache decrypted plaintext.
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (partial) {
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  const status = partial ? 206 : 200;

  event.respondWith(
    requestPreviewStream(entry, start, end)
      .then((stream) => new Response(stream, { status, headers }))
      .catch(
        () =>
          new Response(null, {
            status: 502,
            headers: { "Cache-Control": "no-store" },
          }),
      ),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// PWA share target — /share-target (POST from the OS share sheet)
//
// The shared files are stashed in a dedicated Cache (one numbered entry per
// file, original name/type carried in headers) and the browser is redirected
// to /?shared=1; the page then collects + clears the stash (lib/share-target.ts)
// and feeds the files into the normal drop flow. The Cache API is used instead
// of postMessage because the share POST usually arrives BEFORE any app window
// exists to message.
// ───────────────────────────────────────────────────────────────────────────

const SHARE_TARGET_CACHE = "fd-share-target";

async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => typeof f === "object");
    const cache = await caches.open(SHARE_TARGET_CACHE);
    // Replace any previous stash — a new share supersedes an unclaimed one.
    for (const key of await cache.keys()) await cache.delete(key);
    let i = 0;
    for (const file of files) {
      const headers = {
        "Content-Type": file.type || "application/octet-stream",
        "X-FD-Name": encodeURIComponent(file.name || `shared-${i}`),
        "Cache-Control": "no-store",
      };
      await cache.put(
        `/fd-share-target/${i}`,
        new Response(file, { headers }),
      );
      i += 1;
    }
  } catch {
    // Parsing/stash failure → just land on the app without files.
  }
  return Response.redirect("/?shared=1", 303);
}
