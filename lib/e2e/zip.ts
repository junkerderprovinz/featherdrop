// A bundle saved as one ZIP, streamed while it decrypts. client-zip writes the
// archive: stored entries without compression, since a bundle rarely shrinks
// and the CPU goes to decryption, and ZIP64 records once a size, an offset or
// the file count outgrows the classic format.

import { makeZip, predictLength } from "client-zip";

export interface ZipEntry {
  name: string;
  /** Exact byte count; the archive length is computed from it before any byte is read. */
  size: number;
  /** Read to the end before the next entry starts, so entries can share one source. */
  bytes: AsyncIterable<Uint8Array>;
}

/**
 * Returns a function that turns names from a share header into safe, distinct
 * entry names. The uploader chose them, so a separator or a dot name could
 * otherwise unpack outside the target folder. Distinct ignores case, as the
 * file systems of Windows and macOS do.
 */
function entryNamer(): (name: string) => string {
  const used = new Set<string>();
  return (raw) => {
    let name = Array.from(raw, (c) => (c < " " || c === "/" || c === "\\" ? "_" : c)).join("");
    if (name === "" || name === "." || name === "..") name = "_";
    // A name made of dots before its last one, such as ".._x", has no extension.
    const dot = name.lastIndexOf(".");
    const split = dot > 0 && /[^.]/.test(name.slice(0, dot));
    const [base, ext] = split ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} (${k})${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
}

/** The entry names a ZIP of files with these names gets. */
export function zipEntryNames(names: string[]): string[] {
  return names.map(entryNamer());
}

/** The exact byte length of the ZIP of these files, for Content-Length. */
export function zipLength(files: { name: string; size: number }[]): number {
  const name = entryNamer();
  return Number(predictLength(files.map((f) => ({ name: name(f.name), size: f.size }))));
}

async function* exactly(e: ZipEntry): AsyncGenerator<Uint8Array> {
  let n = 0;
  for await (const part of e.bytes) {
    n += part.length;
    if (n > e.size) throw new Error(`zip: "${e.name}" has more than ${e.size} bytes`);
    yield part;
  }
  if (n !== e.size) throw new Error(`zip: "${e.name}" has ${n} bytes, expected ${e.size}`);
}

/**
 * Streams the entries as a ZIP. An entry whose bytes differ from its size
 * fails the stream, since the length promised in advance would be wrong.
 */
export function zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const name = entryNamer();
  async function* inputs() {
    for await (const e of entries) yield { name: name(e.name), size: e.size, input: exactly(e) };
  }
  return makeZip(inputs());
}
