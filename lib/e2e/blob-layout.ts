// lib/e2e/blob-layout.ts

/** Unsigned LEB128 varint encode. */
export function encodeVarint(n: number): Uint8Array {
  if (n < 0 || !Number.isInteger(n)) throw new Error("varint: non-negative int required");
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return new Uint8Array(out);
}

/** Unsigned LEB128 varint decode from `bytes` at `offset`. */
export function decodeVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 1;
  let i = offset;
  for (; i < bytes.length; i++) {
    const byte = bytes[i];
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, bytesRead: i - offset + 1 };
    shift *= 128;
  }
  throw new Error("varint: truncated");
}

function concat(a: Uint8Array, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Prepend [varint(metaLen)][enc_meta] to the encrypted content stream. */
export async function* assembleBlob(
  encMeta: Uint8Array,
  content: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield concat(encodeVarint(encMeta.length), encMeta);
  for await (const c of content) yield c;
}

/**
 * Absolute byte offset (within the whole blob) at which the content region — the
 * encrypted frames/chunks after [varint(metaLen)][enc_meta] — begins. It is the
 * length of the varint plus `metaLen` bytes. Pure. The cf=2 seekable preview adds
 * this to a chunk's CONTENT-relative cipher byte range to get the ABSOLUTE blob
 * bytes to Range-fetch.
 */
export function contentOffsetForMetaLen(metaLen: number): number {
  return encodeVarint(metaLen).length + metaLen;
}

/**
 * Read just the header of a buffered blob PREFIX: decode the metaLen varint,
 * slice out enc_meta, and report where the content region begins. `prefix` must
 * contain the full [varint(metaLen)][enc_meta] header (the streaming-preview
 * mount fetches the first 8 KiB, which comfortably covers it). Pure +
 * synchronous, so the download mount can derive the contentOffset to pass to the
 * seekable preview without re-walking the stream. Throws if the prefix is too
 * short to hold the whole header.
 */
export function peekBlobHeader(prefix: Uint8Array): {
  encMeta: Uint8Array;
  contentOffset: number;
} {
  const { value: metaLen, bytesRead } = decodeVarint(prefix, 0);
  const contentOffset = bytesRead + metaLen;
  if (prefix.length < contentOffset) {
    throw new Error("blob: prefix too short to hold the full header");
  }
  return {
    encMeta: prefix.subarray(bytesRead, contentOffset),
    contentOffset,
  };
}

/** Peel off enc_meta from a blob stream; return it + the remaining content stream. */
export async function readBlobMeta(
  source: AsyncIterable<Uint8Array>,
): Promise<{ encMeta: Uint8Array; content: AsyncGenerator<Uint8Array> }> {
  const iter = source[Symbol.asyncIterator]();
  let buf = new Uint8Array(0);

  async function pullMore(): Promise<boolean> {
    const r = await iter.next();
    if (r.done) return false;
    buf = concat(buf, r.value);
    return true;
  }

  // Ensure enough bytes to decode the length varint.
  let metaLen: number;
  let headerLen: number;
  for (;;) {
    try {
      const d = decodeVarint(buf, 0);
      metaLen = d.value;
      headerLen = d.bytesRead;
      break;
    } catch {
      if (!(await pullMore())) throw new Error("blob: truncated (no length)");
    }
  }
  // Ensure the full enc_meta is buffered.
  while (buf.length < headerLen + metaLen) {
    if (!(await pullMore())) throw new Error("blob: truncated (incomplete meta)");
  }
  const encMeta = buf.subarray(headerLen, headerLen + metaLen);
  const leftover = buf.subarray(headerLen + metaLen);

  async function* content(): AsyncGenerator<Uint8Array> {
    if (leftover.length > 0) yield leftover;
    for (;;) {
      const r = await iter.next();
      if (r.done) return;
      yield r.value;
    }
  }
  return { encMeta, content: content() };
}
