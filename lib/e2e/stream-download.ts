// Streaming download through a service worker: the worker answers a
// /sw-download/<id> fetch from a hidden iframe with the decrypted stream, so a
// large file never has to fit in memory.

/** Reports whether the service worker path is available; otherwise use blobDownload. */
export function canStreamDownload(): boolean {
  return "serviceWorker" in navigator;
}

let _swReady: Promise<ServiceWorkerRegistration> | null = null;

function ensureSwRegistered(): Promise<ServiceWorkerRegistration> {
  if (_swReady) return _swReady;
  _swReady = navigator.serviceWorker
    .register("/sw-download.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch((err: unknown) => {
      // A cached rejection would break every later download in this session.
      _swReady = null;
      throw err;
    });
  return _swReady;
}

/**
 * Saves a decrypted stream to disk without buffering it. The stream is
 * transferred to the service worker, and a hidden iframe then navigates to
 * /sw-download/<id>, which opens the browser's save dialog.
 *
 * @param size Plaintext length for Content-Length. Chromium fails the download
 *   when it is wrong, so leave it out when unknown.
 */
export async function streamToDownload(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  size?: number,
): Promise<void> {
  await ensureSwRegistered();

  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("Service worker active worker not found");

  const id = crypto.randomUUID();

  sw.postMessage({ id, stream, filename, size }, [
    stream as unknown as Transferable,
  ]);

  // The message reaches the worker before the iframe's fetch does, so the
  // stream is stored first. The extra frame covers slow devices.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "display:none;position:fixed;top:-1px;left:-1px;width:1px;height:1px";
  document.body.appendChild(iframe);
  iframe.src = `/sw-download/${id}`;

  // The download keeps running after the iframe is gone.
  setTimeout(() => {
    try {
      document.body.removeChild(iframe);
    } catch {
      /* already removed */
    }
  }, 60_000);
}

/** Saves an in-memory Blob, for when the service worker is unavailable. */
export function blobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Revoking at once could cancel the download before it starts.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    try {
      document.body.removeChild(a);
    } catch {
      /* already removed */
    }
  }, 100);
}
