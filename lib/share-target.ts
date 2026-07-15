// PWA share-target pickup — the page side of the /share-target flow.
//
// The service worker (public/sw-download.js) stashes files shared via the OS
// share sheet in the "fd-share-target" Cache and redirects to /?shared=1. This
// module collects that stash back into File objects (original name/type carried
// in the stored response headers) and clears it, so a share is consumed exactly
// once. Everything is guarded: no Cache API (insecure context, old browser) or
// an empty stash simply yields [].

const SHARE_TARGET_CACHE = "fd-share-target";

/** True when the current URL indicates a share-sheet launch. */
export function isShareTargetLaunch(
  search: string = typeof location !== "undefined" ? location.search : "",
): boolean {
  return new URLSearchParams(search).has("shared");
}

/** Collect and CLEAR the stashed shared files. */
export async function collectSharedFiles(): Promise<File[]> {
  try {
    if (typeof caches === "undefined") return [];
    const cache = await caches.open(SHARE_TARGET_CACHE);
    // Numbered /fd-share-target/<i> entries — restore the share-sheet order.
    const keys = [...(await cache.keys())].sort((a, b) =>
      a.url.localeCompare(b.url, undefined, { numeric: true }),
    );
    if (keys.length === 0) return [];
    const files: File[] = [];
    for (const key of keys) {
      const res = await cache.match(key);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(
        res.headers.get("X-FD-Name") ?? `shared-${files.length}`,
      );
      files.push(
        new File([blob], name, {
          type: res.headers.get("Content-Type") ?? "application/octet-stream",
        }),
      );
      await cache.delete(key);
    }
    return files;
  } catch {
    return [];
  }
}
