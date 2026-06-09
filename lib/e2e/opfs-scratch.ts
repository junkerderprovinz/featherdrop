// Browser-only OPFS scratch storage for the upload pipeline. Streams an encrypted
// blob into a temporary Origin-Private-File-System file and returns a sliceable
// File (the seekable source the resumable tus upload reads from) plus a cleanup.
// Scratch names embed a timestamp so sweepStaleScratch() can garbage-collect
// leftovers from uploads that were aborted before cleanup ran.

const PREFIX = "fd-scratch-";

// Some TS lib.dom versions omit the async-iterator helpers on
// FileSystemDirectoryHandle; declare the slice we rely on.
interface ScratchDir extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

async function opfsRoot(): Promise<ScratchDir> {
  return (await navigator.storage.getDirectory()) as ScratchDir;
}

/**
 * Stream `blob` into a fresh OPFS scratch file. Returns the file (a sliceable
 * Blob) and a cleanup to delete it. On write failure the partial file is removed
 * and the error rethrown.
 */
export async function writeScratch(
  blob: AsyncIterable<Uint8Array>,
): Promise<{ file: File; cleanup: () => Promise<void> }> {
  const dir = await opfsRoot();
  const name = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    // Chunks are real ArrayBuffer-backed Uint8Arrays at runtime; the cast
    // satisfies TS 5.9's stricter Uint8Array<ArrayBuffer> requirement on write().
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

/** Delete scratch files older than `maxAgeMs` (GC after aborted uploads). */
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
