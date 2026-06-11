// Service worker for streaming downloads — the Firefox-Send / StreamSaver pattern.
// Installed at /sw-download.js (scope /). The main thread transfers a ReadableStream
// via postMessage and then navigates a hidden <iframe> to /sw-download/<id>; the SW
// intercepts that fetch and responds with the stream directly, so the browser saves
// decrypted bytes without ever buffering the whole file in JS heap RAM.

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
  const { id, stream, filename, size } = event.data ?? {};
  if (typeof id === "string" && stream instanceof ReadableStream) {
    pending.set(id, { stream, filename: filename ?? "download", size });
    // Best-effort eviction so a stream for a download that never starts (tab
    // closed before the iframe fetch) doesn't pin its resource chain forever.
    setTimeout(() => pending.delete(id), 60_000);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
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
