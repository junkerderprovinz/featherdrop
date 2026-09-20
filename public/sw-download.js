// Service worker for streaming downloads, the StreamSaver pattern. The page
// transfers a ReadableStream by postMessage and navigates a hidden iframe to
// /sw-download/<id>; the worker answers that fetch with the stream, so the
// decrypted file never has to fit in memory. The same worker serves the
// streaming video preview at /sw-preview/<id> and the PWA share target.

/** @type {Map<string, {stream: ReadableStream<Uint8Array>, filename: string, size?: number}>} */
const pending = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Claiming the open windows lets the very first fetch be intercepted.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
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
    // A download that never starts, because the tab closed first, must not
    // pin its stream forever.
    setTimeout(() => pending.delete(id), 60_000);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // The Android share sheet POSTs shared files here (see manifest.webmanifest).
  if (url.pathname === "/share-target" && event.request.method === "POST") {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  const pm = url.pathname.match(/^\/sw-preview\/([^/]+)$/);
  if (pm) {
    handlePreviewFetch(event, pm[1]);
    return;
  }

  const m = url.pathname.match(/^\/sw-download\/([^/]+)$/);
  if (!m) return;

  const id = m[1];
  const entry = pending.get(id);
  // An unknown id falls through, and the browser 404s the iframe.
  if (!entry) return;

  // Each stream is delivered once.
  pending.delete(id);

  const { stream, filename, size } = entry;
  // An RFC 5987 name for modern browsers and an ASCII fallback for old ones.
  const encodedName = encodeURIComponent(filename).replace(/'/g, "%27");
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");

  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
  };
  // Chromium fails a download whose Content-Length is off, so callers that do
  // not know the exact plaintext length send none.
  if (Number.isFinite(size) && size >= 0) {
    headers["Content-Length"] = String(size);
  }

  event.respondWith(new Response(stream, { status: 200, headers }));
});

// Streaming preview of large videos at /sw-preview/<id>.
//
// The crypto lives on the main thread, so this worker does not decrypt. For
// every Range request of the <video> it asks the controlling page for a fresh
// decrypted stream of exactly [start, end] and pipes it through; nothing is
// collected here. How the page produces a range depends on the content format,
// which only the page knows.

/**
 * Preview registrations by id. Unlike `pending`, an entry stays for many Range
 * requests until it is released or times out.
 * @type {Map<string, {port: MessagePort, mime: string, size: number}>}
 */
const preview = new Map();

function registerPreview(data) {
  const { id, port, mime, size } = data;
  if (typeof id !== "string" || !(port instanceof MessagePort)) return;
  if (!Number.isFinite(size) || size < 0) return;
  preview.set(id, {
    port,
    mime: typeof mime === "string" && mime ? mime : "application/octet-stream",
    size,
  });
  // The page releases on unmount; this covers a closed tab. 30 minutes is
  // longer than any realistic playback.
  setTimeout(() => preview.delete(id), 30 * 60_000);
}

/**
 * Asks the page for a decrypted stream of the inclusive range [start, end].
 * Rejects when the page reports an error.
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
    // The page sends the stream back over the transferred port2.
    entry.port.postMessage({ start, end }, [channel.port2]);
  });
}

/** Parses a single "bytes=start-end" range against size. */
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
    // A suffix range: the last N bytes.
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

function handlePreviewFetch(event, id) {
  const entry = preview.get(id);
  if (!entry) return;

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

  // A <video> starts with an open-ended "bytes=0-". Serving that whole would
  // decrypt the entire file before the first frame, so each response is capped
  // and the element requests the next window as it plays. A capped response is
  // partial and must be a 206.
  const MAX_WINDOW = 4 * 1024 * 1024;
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
    // No sniffing into a scriptable type, and no caching of plaintext.
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

// The PWA share target. The shared files go into a cache, one numbered entry
// each with name and type in headers, and the browser is redirected to
// /?shared=1, where lib/share-target.ts picks them up. A cache rather than
// postMessage, because the share POST usually arrives before any app window
// exists.

const SHARE_TARGET_CACHE = "fd-share-target";

async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => typeof f === "object");
    const cache = await caches.open(SHARE_TARGET_CACHE);
    // A new share replaces one that was never picked up.
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
    // The user still lands on the app, without files.
  }
  return Response.redirect("/?shared=1", 303);
}
