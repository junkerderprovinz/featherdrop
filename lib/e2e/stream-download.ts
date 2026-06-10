// Browser-only streaming download via service worker.
// The SW intercepts a /sw-download/<id> fetch from a hidden <iframe> and responds
// with the ReadableStream directly — no full-file RAM buffer needed for large files.
//
// FS Access API (showSaveFilePicker) would be the ideal alternative when available,
// but cross-browser support is still incomplete and it falls outside this phase's scope.

/**
 * Whether the streaming-download path (service worker) is available in this browser.
 * Call this before streamToDownload; fall back to blobDownload when false.
 */
export function canStreamDownload(): boolean {
  return "serviceWorker" in navigator;
}

// Module-level registration promise so we only call register() once.
let _swReady: Promise<ServiceWorkerRegistration> | null = null;

function ensureSwRegistered(): Promise<ServiceWorkerRegistration> {
  if (_swReady) return _swReady;
  _swReady = navigator.serviceWorker
    .register("/sw-download.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch((err: unknown) => {
      // Don't cache a rejection — a transient failure (e.g. registration blocked
      // on an insecure context) must not poison every later call this session.
      _swReady = null;
      throw err;
    });
  return _swReady;
}

/**
 * Save a large decrypted ReadableStream to disk without buffering it in RAM.
 *
 * Steps:
 *  1. Register /sw-download.js (idempotent — no-ops if already active).
 *  2. Wait for the SW to be ready to intercept fetches.
 *  3. Transfer the ReadableStream to the SW via postMessage (Transferable).
 *  4. Let the SW finish claiming all clients.
 *  5. On the next animation frame, set a hidden <iframe>.src to /sw-download/<id>
 *     so the SW's fetch handler is guaranteed to have stored the stream before the
 *     navigation fires. The iframe triggers the browser's Save-As dialog.
 *  6. Clean up the iframe after a short delay.
 *
 * @param stream  - Decrypted byte stream to save.
 * @param filename - Suggested save-as filename.
 * @param size     - Optional byte-length for Content-Length (improves progress bars).
 */
export async function streamToDownload(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  size?: number,
): Promise<void> {
  await ensureSwRegistered();

  // Ensure the SW has claimed this page before we send the stream.
  // navigator.serviceWorker.ready resolves once an active worker controls the page;
  // if it already has, this resolves synchronously on the next microtask.
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("Service worker active worker not found");

  const id = crypto.randomUUID();

  // Transfer the ReadableStream — it is a Transferable in modern browsers.
  // After this the local `stream` reference is neutered.
  sw.postMessage({ id, stream, filename, size }, [
    // Chunks are Uint8Array<ArrayBuffer> at runtime; cast satisfies TS 5.9 strict
    // Transferable[] which expects ArrayBuffer/MessagePort/ReadableStream etc.
    stream as unknown as Transferable,
  ]);

  // Correctness rests on IPC ordering: the postMessage above is enqueued to the
  // SW before the fetch that the iframe navigation triggers, so the entry is
  // stored first. This extra rAF yield is belt-and-suspenders for slow devices'
  // task scheduling — keep it.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "display:none;position:fixed;top:-1px;left:-1px;width:1px;height:1px";
  document.body.appendChild(iframe);
  iframe.src = `/sw-download/${id}`;

  // Remove the iframe after a generous delay. The browser download continues
  // independently of the iframe's lifetime once the stream is flowing.
  setTimeout(() => {
    try {
      document.body.removeChild(iframe);
    } catch {
      /* already removed */
    }
  }, 60_000);
}

/**
 * Blob-based download fallback for when the SW is unavailable or the file is small
 * enough that RAM buffering is acceptable.
 *
 * @param blob     - Complete file data.
 * @param filename - Suggested save-as filename.
 */
export function blobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Revoke on the next tick so the browser has a chance to start the download.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    try {
      document.body.removeChild(a);
    } catch {
      /* already removed */
    }
  }, 100);
}
