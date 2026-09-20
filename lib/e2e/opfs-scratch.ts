// Scratch storage for the upload: the encrypted blob is streamed into a
// temporary Origin Private File System file, which gives tus a sliceable File to
// resume from. The names carry a timestamp so sweepStaleScratch() can remove
// files left by aborted uploads.

const PREFIX = "fd-scratch-";

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

/**
 * Reports whether OPFS is usable. navigator.storage only exists in a secure
 * context, so on plain HTTP callers take the in-memory fallback.
 */
export function canUseOpfs(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.storage != null &&
    typeof navigator.storage.getDirectory === "function"
  );
}

/**
 * Collects the encrypted blob into one in-memory File for contexts without
 * OPFS. The whole blob sits in memory, so callers cap the size first.
 */
export async function writeMemoryScratch(
  blob: AsyncIterable<Uint8Array>,
): Promise<{ file: File; cleanup: () => Promise<void> }> {
  const parts: BlobPart[] = [];
  // The chunks are ArrayBuffer-backed; the cast satisfies the BlobPart type.
  for await (const chunk of blob) parts.push(chunk as Uint8Array<ArrayBuffer>);
  const file = new File(parts, "fd-upload.bin", {
    type: "application/octet-stream",
  });
  return { file, cleanup: async () => {} };
}

/**
 * Streams blob into a fresh OPFS scratch file and returns it with a cleanup.
 * A failed write removes the partial file and rethrows.
 */
export async function writeScratch(
  blob: AsyncIterable<Uint8Array>,
): Promise<{ file: File; cleanup: () => Promise<void> }> {
  const dir = await opfsRoot();
  const name = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    for await (const chunk of blob) await writable.write(chunk as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      /* writable may already be closed */
    }
    try {
      await dir.removeEntry(name);
    } catch {
      /* nothing to remove */
    }
    throw err;
  }
  const file = await handle.getFile();
  const cleanup = async (): Promise<void> => {
    try {
      await dir.removeEntry(name);
    } catch {
      /* already gone */
    }
  };
  return { file, cleanup };
}

/** Deletes scratch files older than maxAgeMs. */
export async function sweepStaleScratch(maxAgeMs: number): Promise<void> {
  const dir = await opfsRoot();
  const now = Date.now();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file" || !name.startsWith(PREFIX)) continue;
    const ts = Number(name.slice(PREFIX.length).split("-")[0]);
    if (Number.isFinite(ts) && now - ts > maxAgeMs) {
      try {
        await dir.removeEntry(name);
      } catch {
        /* raced with another sweep */
      }
    }
  }
}
