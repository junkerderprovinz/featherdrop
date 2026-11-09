// Where the bytes of a v2 container sit (see ./share.ts for the format). The
// page plans uploads and range reads with it, and the crypto worker seals and
// opens the bytes it names.

import { paddedContentLength, MIN_HEADER_PAD } from "./padding";
import { FORMAT_VERSION, type KdfParams, type Mode } from "./token";

/** A text share holds a note: one unnamed entry of type TEXT_TYPE. */
export type Kind = "single" | "bundle" | "text";

export const TEXT_TYPE = "text/plain; charset=utf-8";

export interface FileEntry {
  name: string;
  type: string;
  size: number;
}

export interface Header {
  v: 2;
  kind: Kind;
  mode: Mode;
  kdf: KdfParams | null;
  /** Plaintext bytes per chunk. */
  chunk: number;
  pad: "padme";
  /** Base nonce of the content chunks, standard base64. */
  nonce: string;
  /** Total plaintext length, the sum of the file sizes. */
  size: number;
  files: FileEntry[];
}

export const PREFIX_BYTES = 5;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;
export const MAX_SEALED = 16 * 1024 * 1024;

export function getU32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
}

export function chunkCount(padded: number, chunk: number): number {
  return Math.ceil(padded / chunk);
}

export function cipherChunkLength(header: Header, n: number, i: number): number {
  const padded = paddedContentLength(header.size);
  const plain = i === n - 1 ? padded - i * header.chunk : header.chunk;
  return plain + TAG_BYTES;
}

/**
 * Length of version, length field and sealed header, read from the first five
 * bytes of a blob. The content starts right after.
 */
export function headerLength(prefix: Uint8Array): number {
  if (prefix.length < PREFIX_BYTES) throw new Error("v2: blob truncated in the header");
  if (prefix[0] !== FORMAT_VERSION) throw new Error("v2: unknown version");
  const sealed = getU32(prefix, 1);
  if (sealed < NONCE_BYTES + MIN_HEADER_PAD + TAG_BYTES || sealed > MAX_SEALED) {
    throw new Error("v2: header length out of range");
  }
  return PREFIX_BYTES + sealed;
}

/** What reproduces any byte of a blob: the sealed prefix, the header it seals and the content key. */
export interface BlobState {
  prefix: Uint8Array;
  header: Header;
  contentKey: Uint8Array;
}

/** A blob of known length whose bytes are produced on demand. */
export interface BlobSource {
  readonly size: number;
  /** The bytes [start, end), cut at the end of the blob. */
  slice(start: number, end: number): Promise<Uint8Array>;
}

export function blobLayout(state: BlobState) {
  const { prefix, header } = state;
  const padded = paddedContentLength(header.size);
  const n = chunkCount(padded, header.chunk);
  return { padded, n, full: header.chunk + TAG_BYTES, size: prefix.length + padded + n * TAG_BYTES };
}

/** Exact length of the blob the state describes. */
export function blobLength(state: BlobState): number {
  return blobLayout(state).size;
}

/**
 * The plaintext range [from, to) whose chunks seal into the blob bytes
 * [start, end), which lie within the blob. A range inside the prefix needs
 * no plaintext and gives to <= from.
 */
export function plainSpan(state: BlobState, start: number, end: number): { from: number; to: number } {
  const { prefix, header } = state;
  const { full } = blobLayout(state);
  if (end <= prefix.length) return { from: 0, to: 0 };
  const cs = Math.max(start, prefix.length) - prefix.length;
  const ce = end - prefix.length;
  const from = Math.floor(cs / full) * header.chunk;
  const to = Math.min((Math.floor((ce - 1) / full) + 1) * header.chunk, header.size);
  return { from, to };
}

/**
 * The blob as random-access bytes. A slice seals only the chunks it covers,
 * from the plaintext range readPlain returns. Chunks depend on nothing but the
 * key, the base nonce and the index, so every slice equals the same bytes of
 * encryptStream's output and an upload can pick up at any offset. On the page
 * seal hands the work to the crypto worker.
 */
export function blobSource(
  state: BlobState,
  readPlain: (start: number, end: number) => Promise<Uint8Array>,
  seal: (start: number, end: number, plain: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): BlobSource {
  const size = blobLength(state);
  return {
    size,
    async slice(start, end) {
      const s = Math.max(0, start);
      const e = Math.min(end, size);
      if (e <= s) return new Uint8Array(0);
      const { from, to } = plainSpan(state, s, e);
      let plain: Uint8Array = new Uint8Array(0);
      if (to > from) {
        plain = await readPlain(from, to);
        if (plain.length !== to - from) throw new Error("v2: the plaintext read came back short");
      }
      return seal(s, e, plain);
    },
  };
}

/**
 * The inclusive blob byte range [from, to] holding the chunks that cover the
 * plaintext range [start, end], or null when the range is empty.
 */
export function cipherRange(
  header: Header,
  contentOffset: number,
  start: number,
  end: number,
): { from: number; to: number; first: number; last: number } | null {
  const s = Math.max(0, start);
  const e = Math.min(header.size - 1, end);
  if (e < s) return null;
  const n = chunkCount(paddedContentLength(header.size), header.chunk);
  const full = header.chunk + TAG_BYTES;
  const first = Math.floor(s / header.chunk);
  const last = Math.floor(e / header.chunk);
  const from = contentOffset + first * full;
  const to = contentOffset + last * full + cipherChunkLength(header, n, last) - 1;
  return { from, to, first, last };
}
