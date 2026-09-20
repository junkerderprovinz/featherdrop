// The page side of the PWA share target. The service worker
// (public/sw-download.js) stores files shared from the OS share sheet in the
// "fd-share-target" cache and redirects to /?shared=1. This module turns that
// stash back into File objects, with name and type from the stored headers,
// and clears it so a share is used once. Without the Cache API it yields [].

const SHARE_TARGET_CACHE = "fd-share-target";

export function isShareTargetLaunch(
  search: string = typeof location !== "undefined" ? location.search : "",
): boolean {
  return new URLSearchParams(search).has("shared");
}

/** Collects the shared files and clears the stash. */
export async function collectSharedFiles(): Promise<File[]> {
  try {
    if (typeof caches === "undefined") return [];
    const cache = await caches.open(SHARE_TARGET_CACHE);
    // The entries are numbered /fd-share-target/<i> in share-sheet order.
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
