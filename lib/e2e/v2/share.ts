// The v2 container (server format 4), byte for byte in docs/encryption-format.md:
//
//   blob    = version(1) || u32be(sealedLen) || sealed || chunk_0 || ... || chunk_{n-1}
//   sealed  = nonce(24) || XChaCha20-Poly1305(headerKey, nonce, padded header, aad = first 5 bytes)
//   chunk_i = XChaCha20-Poly1305(contentKey, baseNonce ^ i, padded plaintext slice, aad = u64be(i) || final)
//
// The header names the kind, mode, KDF parameters, chunk size and padding
// scheme, so the server can neither see nor swap them. Both the header and the
// content are Padmé-padded, so all the blob tells the server is two padded
// lengths. Encryption and decryption are push-based so they run unchanged in a
// Web Worker and can feed an upload as the bytes are produced.

import { aeadEncrypt, aeadDecrypt, toBase64, fromBase64, loadSodium } from "../crypto";
import { deriveNonce } from "../seekable";
import { paddedContentLength, paddedHeaderLength, MIN_HEADER_PAD } from "./padding";
import {
  FORMAT_VERSION,
  MIN_PASSWORD_LENGTH,
  newToken,
  encodeToken,
  decodeToken,
  deriveKeys,
  isPasswordLongEnough,
  type KdfParams,
  type Mode,
  type ShareKeys,
} from "./keys";

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

export const DEFAULT_CHUNK = 65536;
const MIN_CHUNK = 4096;
const MAX_CHUNK = 16 * 1024 * 1024;
const PREFIX_BYTES = 5;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const MAX_SEALED = 16 * 1024 * 1024;

const utf8 = new TextEncoder();

function getU32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
}

function setU32(b: Uint8Array, at: number, v: number): void {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v);
}

function chunkAad(i: number, final: boolean): Uint8Array {
  const aad = new Uint8Array(9);
  setU32(aad, 0, Math.floor(i / 0x1_0000_0000));
  setU32(aad, 4, i >>> 0);
  aad[8] = final ? 1 : 0;
  return aad;
}

function chunkCount(padded: number, chunk: number): number {
  return Math.ceil(padded / chunk);
}

function isChunkSize(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= MIN_CHUNK &&
    n <= MAX_CHUNK &&
    (n & (n - 1)) === 0
  );
}

function isSize(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function hasExactKeys(o: object, keys: string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

const HEADER_KEYS = ["v", "kind", "mode", "kdf", "chunk", "pad", "nonce", "size", "files"];

function isTextEntry(files: FileEntry[]): boolean {
  return files.length === 1 && files[0].name === "" && files[0].type === TEXT_TYPE;
}

function sameKdf(a: KdfParams | null, b: KdfParams | null): boolean {
  if (a === null || b === null) return a === b;
  return hasExactKeys(a, ["alg", "ops", "mem"]) && a.alg === b.alg && a.ops === b.ops && a.mem === b.mem;
}

/** Throws unless h is a well-formed header for the mode and KDF of keys. */
function checkHeader(h: unknown, keys: ShareKeys): Header {
  const bad = (why: string) => new Error(`v2: invalid header (${why})`);
  if (typeof h !== "object" || h === null || !hasExactKeys(h, HEADER_KEYS)) throw bad("fields");
  const x = h as Header;
  if (x.v !== 2) throw bad("v");
  if (x.kind !== "single" && x.kind !== "bundle" && x.kind !== "text") throw bad("kind");
  if (x.mode !== keys.mode) throw bad("mode");
  if (typeof x.kdf !== "object" || !sameKdf(x.kdf, keys.kdf)) throw bad("kdf");
  if (!isChunkSize(x.chunk)) throw bad("chunk");
  if (x.pad !== "padme") throw bad("pad");
  if (typeof x.nonce !== "string" || fromBase64(x.nonce).length !== NONCE_BYTES) throw bad("nonce");
  if (!Array.isArray(x.files) || x.files.length === 0) throw bad("files");
  if (x.kind === "single" && x.files.length !== 1) throw bad("single with several files");
  let total = 0;
  for (const f of x.files) {
    if (
      typeof f !== "object" ||
      f === null ||
      !hasExactKeys(f, ["name", "type", "size"]) ||
      typeof f.name !== "string" ||
      typeof f.type !== "string" ||
      !isSize(f.size)
    ) {
      throw bad("file entry");
    }
    total += f.size;
  }
  if (!isSize(x.size) || x.size !== total) throw bad("size");
  if (x.kind === "text" && !isTextEntry(x.files)) throw bad("text with a name, another type or several entries");
  return x;
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

/** Opens and checks the header. bytes must hold at least headerLength(bytes) bytes. */
export function readHeader(keys: ShareKeys, bytes: Uint8Array): { header: Header; contentOffset: number } {
  const len = headerLength(bytes);
  if (bytes.length < len) throw new Error("v2: blob truncated in the header");
  let plain: Uint8Array;
  try {
    plain = aeadDecrypt(
      bytes.subarray(PREFIX_BYTES + NONCE_BYTES, len),
      bytes.subarray(0, PREFIX_BYTES),
      bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + NONCE_BYTES),
      keys.header,
    );
  } catch {
    throw new Error("v2: header does not open (wrong link, wrong password or tampered)");
  }
  const jsonLen = getU32(plain, 0);
  if (4 + jsonLen > plain.length || paddedHeaderLength(4 + jsonLen) !== plain.length) {
    throw new Error("v2: invalid header (padding)");
  }
  if (plain.subarray(4 + jsonLen).some((b) => b !== 0)) throw new Error("v2: invalid header (padding)");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain.subarray(4, 4 + jsonLen)));
  } catch {
    throw new Error("v2: invalid header (json)");
  }
  return { header: checkHeader(parsed, keys), contentOffset: len };
}

function sealHeader(keys: ShareKeys, header: Header, nonce: Uint8Array): Uint8Array {
  const json = utf8.encode(JSON.stringify(header));
  const plain = new Uint8Array(paddedHeaderLength(4 + json.length));
  setU32(plain, 0, json.length);
  plain.set(json, 4);
  const sealedLen = NONCE_BYTES + plain.length + TAG_BYTES;
  if (sealedLen > MAX_SEALED) throw new Error("v2: too many files for one share");
  const out = new Uint8Array(PREFIX_BYTES + sealedLen);
  out[0] = FORMAT_VERSION;
  setU32(out, 1, sealedLen);
  out.set(nonce, PREFIX_BYTES);
  out.set(aeadEncrypt(plain, out.subarray(0, PREFIX_BYTES), nonce, keys.header), PREFIX_BYTES + NONCE_BYTES);
  return out;
}

/** Decrypts chunk i of n and returns its plaintext with the padding cut off. */
function openChunk(keys: ShareKeys, header: Header, baseNonce: Uint8Array, n: number, i: number, frame: Uint8Array): Uint8Array {
  let plain: Uint8Array;
  try {
    plain = aeadDecrypt(frame, chunkAad(i, i === n - 1), deriveNonce(baseNonce, i), keys.content);
  } catch {
    throw new Error(`v2: chunk ${i} does not open (tampered, reordered or from another share)`);
  }
  const real = Math.min(plain.length, Math.max(0, header.size - i * header.chunk));
  if (plain.subarray(real).some((b) => b !== 0)) throw new Error(`v2: chunk ${i} has nonzero padding`);
  return plain.subarray(0, real);
}

/** Seals chunk i of n, whose plaintext is already padded to its full length. */
function sealChunk(key: Uint8Array, baseNonce: Uint8Array, n: number, i: number, plain: Uint8Array): Uint8Array {
  return aeadEncrypt(plain, chunkAad(i, i === n - 1), deriveNonce(baseNonce, i), key);
}

function cipherChunkLength(header: Header, n: number, i: number): number {
  const padded = paddedContentLength(header.size);
  const plain = i === n - 1 ? padded - i * header.chunk : header.chunk;
  return plain + TAG_BYTES;
}

export class ShareEncryptor {
  readonly header: Header;
  /** Version, length field and sealed header: the first bytes of the blob. */
  readonly prefix: Uint8Array;
  /** Exact length of the finished blob, known before any content is read. */
  readonly blobLength: number;
  readonly verifier: string;
  private readonly key: Uint8Array;
  private readonly baseNonce: Uint8Array;
  private readonly padded: number;
  private readonly n: number;
  private readonly buf: Uint8Array;
  private fill = 0;
  private i = 0;
  private received = 0;

  constructor(keys: ShareKeys, header: Header, headerNonce: Uint8Array, baseNonce: Uint8Array) {
    this.header = header;
    this.prefix = sealHeader(keys, header, headerNonce);
    this.verifier = keys.verifier;
    this.key = keys.content;
    this.baseNonce = baseNonce;
    this.padded = paddedContentLength(header.size);
    this.n = chunkCount(this.padded, header.chunk);
    this.blobLength = this.prefix.length + this.padded + this.n * TAG_BYTES;
    this.buf = new Uint8Array(header.chunk);
  }

  /** The content key with the sealed header, which together reproduce any byte of the blob. */
  get state(): BlobState {
    return { prefix: this.prefix, header: this.header, contentKey: this.key };
  }

  private seal(): Uint8Array {
    const out = sealChunk(this.key, this.baseNonce, this.n, this.i, this.buf.subarray(0, this.fill));
    this.i++;
    this.fill = 0;
    return out;
  }

  /** Takes plaintext in any slicing and returns the chunks it completes. */
  push(data: Uint8Array): Uint8Array[] {
    if (this.received + data.length > this.header.size) {
      throw new Error("v2: more bytes than the declared size");
    }
    this.received += data.length;
    const out: Uint8Array[] = [];
    let off = 0;
    while (off < data.length) {
      const take = Math.min(this.header.chunk - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + take), this.fill);
      this.fill += take;
      off += take;
      // The final chunk waits for finish(), which knows it is final.
      if (this.fill === this.header.chunk && this.i < this.n - 1) out.push(this.seal());
    }
    return out;
  }

  /** Pads, seals and yields the remaining chunks, the final one last. */
  *finish(): Generator<Uint8Array> {
    if (this.received !== this.header.size) throw new Error("v2: fewer bytes than the declared size");
    while (this.i < this.n) {
      const end = this.i === this.n - 1 ? this.padded - this.i * this.header.chunk : this.header.chunk;
      this.buf.fill(0, this.fill, end);
      this.fill = end;
      yield this.seal();
    }
  }
}

/**
 * Builds an encryptor from explicit key material. Callers outside tests and
 * test vectors use createEncryptor, which draws fresh nonces.
 */
export function buildEncryptor(opts: {
  keys: ShareKeys;
  kind: Kind;
  files: FileEntry[];
  chunk: number;
  headerNonce: Uint8Array;
  baseNonce: Uint8Array;
}): ShareEncryptor {
  const { keys, kind, files, chunk, headerNonce, baseNonce } = opts;
  if (files.length === 0) throw new Error("v2: no files");
  if (kind === "single" && files.length !== 1) throw new Error("v2: a single share holds one file");
  if (kind === "text" && !isTextEntry(files)) throw new Error("v2: a text share holds one unnamed plain text entry");
  if (!isChunkSize(chunk)) throw new Error("v2: invalid chunk size");
  if (headerNonce.length !== NONCE_BYTES || baseNonce.length !== NONCE_BYTES) throw new Error("v2: invalid nonce");
  let size = 0;
  for (const f of files) {
    if (!isSize(f.size)) throw new Error("v2: invalid file size");
    size += f.size;
  }
  if (!isSize(size)) throw new Error("v2: total size too large");
  const header: Header = {
    v: 2,
    kind,
    mode: keys.mode,
    kdf: keys.kdf,
    chunk,
    pad: "padme",
    nonce: toBase64(baseNonce),
    size,
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
  };
  return new ShareEncryptor(keys, header, headerNonce, baseNonce);
}

/**
 * Starts a new share: a fresh link token, its keys and an encryptor. One file
 * becomes a single share, several a bundle, unless opts.kind says otherwise.
 * With a password the share needs both the link and the password.
 */
export async function createEncryptor(
  files: FileEntry[],
  opts: { password?: string; kind?: Kind } = {},
): Promise<ShareEncryptor & { token: string }> {
  const { password } = opts;
  if (password !== undefined && !isPasswordLongEnough(password)) {
    throw new Error(`v2: the password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const sodium = await loadSodium();
  const token = await newToken(password === undefined ? "link" : "link+password");
  const keys = await deriveKeys(token, password);
  const enc = buildEncryptor({
    keys,
    kind: opts.kind ?? (files.length === 1 ? "single" : "bundle"),
    files,
    chunk: DEFAULT_CHUNK,
    headerNonce: sodium.randombytes_buf(NONCE_BYTES),
    baseNonce: sodium.randombytes_buf(NONCE_BYTES),
  });
  return Object.assign(enc, { token: encodeToken(token) });
}

/** The whole blob as a stream: prefix, then the chunks as plaintext arrives. */
export async function* encryptStream(
  enc: ShareEncryptor,
  plaintext: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield enc.prefix;
  for await (const part of plaintext) yield* enc.push(part);
  yield* enc.finish();
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

function layout(state: BlobState) {
  const { prefix, header } = state;
  const padded = paddedContentLength(header.size);
  const n = chunkCount(padded, header.chunk);
  return { padded, n, full: header.chunk + TAG_BYTES, size: prefix.length + padded + n * TAG_BYTES };
}

/** Exact length of the blob state describes. */
export function blobLength(state: BlobState): number {
  return layout(state).size;
}

/**
 * The plaintext range [from, to) whose chunks seal into the blob bytes
 * [start, end), which lie within the blob. A range inside the prefix needs
 * no plaintext and gives to <= from.
 */
export function plainSpan(state: BlobState, start: number, end: number): { from: number; to: number } {
  const { prefix, header } = state;
  const { full } = layout(state);
  if (end <= prefix.length) return { from: 0, to: 0 };
  const cs = Math.max(start, prefix.length) - prefix.length;
  const ce = end - prefix.length;
  const from = Math.floor(cs / full) * header.chunk;
  const to = Math.min((Math.floor((ce - 1) / full) + 1) * header.chunk, header.size);
  return { from, to };
}

/**
 * The blob bytes [start, end), which lie within the blob, sealed from plain,
 * the plaintext plainSpan names for them.
 */
export function sealSpan(state: BlobState, start: number, end: number, plain: Uint8Array): Uint8Array {
  const { prefix, header, contentKey } = state;
  const { padded, n, full } = layout(state);
  const out = new Uint8Array(end - start);
  let at = 0;
  if (start < prefix.length) {
    const head = prefix.subarray(start, Math.min(end, prefix.length));
    out.set(head);
    at = head.length;
  }
  if (end <= prefix.length) return out;

  const baseNonce = fromBase64(header.nonce);
  const cs = Math.max(start, prefix.length) - prefix.length;
  const ce = end - prefix.length;
  const first = Math.floor(cs / full);
  const last = Math.floor((ce - 1) / full);
  const plainFrom = first * header.chunk;
  for (let i = first; i <= last; i++) {
    const chunkPlain = new Uint8Array(i === n - 1 ? padded - i * header.chunk : header.chunk);
    const from = i * header.chunk - plainFrom;
    if (from < plain.length) chunkPlain.set(plain.subarray(from, from + chunkPlain.length));
    const sealed = sealChunk(contentKey, baseNonce, n, i, chunkPlain);
    const a = Math.max(0, cs - i * full);
    const b = Math.min(sealed.length, ce - i * full);
    out.set(sealed.subarray(a, b), at);
    at += b - a;
  }
  return out;
}

/**
 * The blob as random-access bytes. A slice seals only the chunks it covers,
 * from the plaintext range readPlain returns. Chunks depend on nothing but the
 * key, the base nonce and the index, so every slice equals the same bytes of
 * encryptStream's output and an upload can pick up at any offset. The page
 * passes a seal that hands the work to the crypto worker.
 */
export function blobSource(
  state: BlobState,
  readPlain: (start: number, end: number) => Promise<Uint8Array>,
  seal: (start: number, end: number, plain: Uint8Array) => Uint8Array | Promise<Uint8Array> = (s, e, p) =>
    sealSpan(state, s, e, p),
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

/** Derives the keys for a link token from the URL fragment. */
export async function openKeys(token: string, password?: string): Promise<ShareKeys> {
  return deriveKeys(decodeToken(token), password);
}

/** Push-based decryption of a whole blob in order. */
export class ShareDecryptor {
  header: Header | null = null;
  contentOffset = 0;
  private readonly keys: ShareKeys;
  // Reads arrive in small pieces and a chunk can be 16 MiB, so the pieces are
  // joined once per chunk instead of on every read.
  private pending: Uint8Array[] = [];
  private buffered = 0;
  private baseNonce: Uint8Array = new Uint8Array(0);
  private n = 0;
  private i = 0;

  constructor(keys: ShareKeys) {
    this.keys = keys;
  }

  get done(): boolean {
    return this.header !== null && this.i === this.n;
  }

  /** Copies the first n buffered bytes. */
  private peek(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    for (const p of this.pending) {
      const k = Math.min(p.length, n - off);
      out.set(p.subarray(0, k), off);
      off += k;
      if (off === n) break;
    }
    return out;
  }

  /** Removes and returns the first n buffered bytes. */
  private take(n: number): Uint8Array {
    const out = this.pending[0].length >= n ? this.pending[0].subarray(0, n) : this.peek(n);
    let skip = n;
    while (skip > 0 && skip >= this.pending[0].length) skip -= this.pending.shift()!.length;
    if (skip > 0) this.pending[0] = this.pending[0].subarray(skip);
    this.buffered -= n;
    return out;
  }

  /** Takes blob bytes in any slicing and returns the plaintext they complete. */
  push(data: Uint8Array): Uint8Array[] {
    if (data.length > 0) {
      this.pending.push(data);
      this.buffered += data.length;
    }
    if (this.header === null) {
      if (this.buffered < PREFIX_BYTES) return [];
      const len = headerLength(this.peek(PREFIX_BYTES));
      if (this.buffered < len) return [];
      const { header, contentOffset } = readHeader(this.keys, this.take(len));
      this.header = header;
      this.contentOffset = contentOffset;
      this.baseNonce = fromBase64(header.nonce);
      this.n = chunkCount(paddedContentLength(header.size), header.chunk);
    }
    const out: Uint8Array[] = [];
    while (this.i < this.n) {
      const len = cipherChunkLength(this.header, this.n, this.i);
      if (this.buffered < len) break;
      const plain = openChunk(this.keys, this.header, this.baseNonce, this.n, this.i, this.take(len));
      this.i++;
      if (plain.length > 0) out.push(plain);
    }
    if (this.done && this.buffered > 0) throw new Error("v2: trailing bytes after the final chunk");
    return out;
  }

  /** Throws unless the final chunk has arrived. */
  finish(): void {
    if (this.header === null) throw new Error("v2: blob truncated in the header");
    if (!this.done) throw new Error("v2: blob truncated");
  }
}

/**
 * Decrypts a blob stream. The header is read and checked before this
 * resolves; the plaintext stream throws on any later tampering or truncation.
 */
export async function decryptShare(
  cipher: AsyncIterable<Uint8Array>,
  keys: ShareKeys,
): Promise<{ header: Header; plaintext: AsyncGenerator<Uint8Array> }> {
  const iter = cipher[Symbol.asyncIterator]();
  const dec = new ShareDecryptor(keys);
  const first: Uint8Array[] = [];
  while (dec.header === null) {
    const r = await iter.next();
    if (r.done) throw new Error("v2: blob truncated in the header");
    first.push(...dec.push(r.value));
  }
  async function* plaintext(): AsyncGenerator<Uint8Array> {
    yield* first;
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      yield* dec.push(r.value);
    }
    dec.finish();
  }
  return { header: dec.header, plaintext: plaintext() };
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

/**
 * Yields the plaintext of the inclusive range [start, end], fetching only the
 * chunks that cover it. fetchRange returns an inclusive byte range of the
 * blob, in the browser an HTTP Range request.
 */
export async function* decryptRange(
  keys: ShareKeys,
  header: Header,
  contentOffset: number,
  fetchRange: (start: number, end: number) => Promise<Uint8Array>,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  const plan = cipherRange(header, contentOffset, start, end);
  if (plan === null) return;
  const fetched = await fetchRange(plan.from, plan.to);
  if (fetched.length !== plan.to - plan.from + 1) throw short();
  yield* decryptRangeStream(keys, header, contentOffset, [fetched], start, end);
}

/**
 * Push-based decryption of the inclusive plaintext range [start, end] from the
 * blob bytes cipherRange names for it, in any slicing. Each chunk is opened as
 * soon as it is complete, so a large range never sits in memory whole.
 */
export class RangeDecryptor {
  private readonly keys: ShareKeys;
  private readonly header: Header;
  private readonly baseNonce: Uint8Array;
  private readonly n: number;
  private readonly s: number;
  private readonly e: number;
  private readonly last: number;
  private pending: Uint8Array[] = [];
  private buffered = 0;
  private i: number;

  constructor(keys: ShareKeys, header: Header, contentOffset: number, start: number, end: number) {
    const plan = cipherRange(header, contentOffset, start, end);
    this.keys = keys;
    this.header = header;
    this.baseNonce = fromBase64(header.nonce);
    this.n = chunkCount(paddedContentLength(header.size), header.chunk);
    this.s = Math.max(0, start);
    this.e = Math.min(header.size - 1, end);
    // An empty range takes no bytes at all.
    this.i = plan?.first ?? 0;
    this.last = plan?.last ?? -1;
  }

  /** Takes blob bytes in any slicing and returns the plaintext of the chunks they complete. */
  push(data: Uint8Array): Uint8Array[] {
    if (data.length === 0) return [];
    if (this.i > this.last) throw short();
    this.pending.push(data);
    this.buffered += data.length;
    const out: Uint8Array[] = [];
    const { header } = this;
    while (this.i <= this.last) {
      const len = cipherChunkLength(header, this.n, this.i);
      if (this.buffered < len) break;
      const joined = this.pending.length === 1 ? this.pending[0] : new Uint8Array(this.buffered);
      if (this.pending.length > 1) {
        let at = 0;
        for (const p of this.pending) {
          joined.set(p, at);
          at += p.length;
        }
      }
      const plain = openChunk(this.keys, header, this.baseNonce, this.n, this.i, joined.subarray(0, len));
      this.pending = this.buffered > len ? [joined.subarray(len)] : [];
      this.buffered -= len;
      const chunkStart = this.i * header.chunk;
      const a = Math.max(0, this.s - chunkStart);
      const b = Math.min(plain.length, this.e + 1 - chunkStart);
      this.i++;
      if (b > a) out.push(plain.subarray(a, b));
    }
    return out;
  }

  /** Throws unless exactly the bytes of the range arrived. */
  finish(): void {
    if (this.i <= this.last || this.buffered > 0) throw short();
  }
}

function short(): Error {
  return new Error("v2: range fetch returned the wrong length");
}

/**
 * Yields the plaintext of the inclusive range [start, end] from cipher, which
 * holds exactly the blob bytes cipherRange names for it, in any slicing.
 */
export async function* decryptRangeStream(
  keys: ShareKeys,
  header: Header,
  contentOffset: number,
  cipher: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  if (cipherRange(header, contentOffset, start, end) === null) return;
  const dec = new RangeDecryptor(keys, header, contentOffset, start, end);
  for await (const part of cipher) yield* dec.push(part);
  dec.finish();
}
