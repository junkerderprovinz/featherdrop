// The message protocol between the page and the crypto Web Worker, which runs
// every libsodium call of the client (./serve.ts answers the requests). The
// worker derives keys and seals and opens chunks; the page reads files, talks
// to the server and passes the bytes through. Keys travel as plain bytes:
// create hands the page the blob state, content key included, because
// resuming an upload after a reload needs it. Every request carries an id and
// gets exactly one reply with the same id.

import type { BlobState, FileEntry, Header, Kind } from "./layout";
import type { ShareKeys } from "./token";
import type { RequestKeys } from "./request-link";
import type { FileMeta } from "../crypto";
import type { Manifest } from "../multi-file";
import type { DownloadSecret, WrappedKey } from "../pipeline";

export type Request =
  /** Starts a share: a fresh link token and what reproduces every byte of its blob. */
  | { op: "create"; files: FileEntry[]; password?: string; kind?: Kind }
  /** Seals the blob bytes [start, end) from the plaintext plainSpan names for them. */
  | { op: "seal"; state: BlobState; start: number; end: number; plain: Uint8Array }
  /** Derives the keys (Argon2id in password mode), or takes keys the page has, and returns the verifier. */
  | ({ op: "decrypt-open"; session: number } & ({ token: string; password?: string } | { keys: ShareKeys }))
  | { op: "decrypt-write"; session: number; data: Uint8Array }
  | { op: "decrypt-close"; session: number }
  /** Opens the header from the blob's first headerLength bytes and keeps it for seeking. */
  | { op: "read-header"; session: number; data: Uint8Array }
  /**
   * Starts decrypting [start, end] under the header the worker opened, so the
   * page cannot hand it another one. range-write takes the blob bytes
   * cipherRange names, in any slicing, and range-close checks they all came.
   */
  | { op: "range-open"; session: number; start: number; end: number }
  | { op: "range-write"; session: number; data: Uint8Array }
  | { op: "range-close"; session: number }
  | { op: "close"; session: number }
  /** Derives the keys of a link token, with Argon2id when it needs the password. */
  | { op: "keys"; token: string; password?: string }
  /** Opens the header in a blob's first headerLength bytes, outside any session. */
  | { op: "header"; keys: ShareKeys; data: Uint8Array }
  /** base64url(SHA-256(token)), the hash the server keeps of a manage or collect token. */
  | { op: "hash-token"; token: string }
  /** The key pair and collect token of a file request, derived from its secret. */
  | { op: "request-keys"; secret: Uint8Array }
  /** Seals the link token of an upload to a request's public key. */
  | { op: "seal-token"; token: string; publicKey: Uint8Array }
  | { op: "open-token"; sealed: Uint8Array; keys: RequestKeys }
  /** The content key of a format 2 or 3 share, unwrapped with Argon2id in password mode, and its verifier. */
  | { op: "legacy-key"; secret: DownloadSecret }
  /** Opens the enc_meta of a format 2 share from the start of its blob. */
  | { op: "legacy-meta"; key: Uint8Array; data: Uint8Array }
  /** Opens the manifest of a format 3 share from the start of its blob. */
  | { op: "legacy-manifest"; key: Uint8Array; data: Uint8Array }
  /**
   * Starts a format 2 share of one file or a format 3 share of several.
   * legacy-write takes their plaintext laid end to end and returns blob bytes.
   */
  | { op: "legacy-encrypt"; session: number; format: 2 | 3; files: FileEntry[]; password?: string }
  /** Starts decrypting a format 2 or 3 blob; legacy-write takes its bytes and returns plaintext. */
  | { op: "legacy-decrypt"; session: number; format: 2 | 3; key: Uint8Array }
  | { op: "legacy-write"; session: number; data: Uint8Array }
  | { op: "legacy-close"; session: number }
  /**
   * Decrypts the plaintext range [start, end] of a seekable format 2 share
   * from data, the blob bytes seekCipherByteRange names for it.
   */
  | {
      op: "legacy-range";
      key: Uint8Array;
      baseNonce: Uint8Array;
      size: number;
      start: number;
      end: number;
      data: Uint8Array;
    };

/** The content key of a format 2 or 3 share with the verifier its downloads send. */
export interface LegacyKey {
  key: Uint8Array;
  verifier: string;
}

/** What a legacy session made of the bytes so far. meta or manifest is set once, in the reply that opened it. */
export interface LegacyOutput {
  meta: FileMeta | null;
  manifest: Manifest | null;
  chunks: Uint8Array[];
}

export interface Responses {
  create: { token: string; verifier: string; state: BlobState };
  seal: { data: Uint8Array };
  "decrypt-open": { verifier: string };
  /** header is set once, in the reply that completed it. */
  "decrypt-write": { header: Header | null; chunks: Uint8Array[] };
  "decrypt-close": Record<string, never>;
  "read-header": { header: Header; contentOffset: number };
  "range-open": Record<string, never>;
  "range-write": { chunks: Uint8Array[] };
  "range-close": Record<string, never>;
  close: Record<string, never>;
  keys: { keys: ShareKeys };
  header: { header: Header; contentOffset: number };
  "hash-token": { hash: string };
  "request-keys": RequestKeys;
  "seal-token": { sealed: Uint8Array };
  "open-token": { token: string };
  "legacy-key": LegacyKey;
  "legacy-meta": { meta: FileMeta; contentOffset: number };
  "legacy-manifest": { manifest: Manifest };
  "legacy-encrypt": { keyForUrl: string; wrapped?: WrappedKey; keyVerifier: string };
  "legacy-decrypt": Record<string, never>;
  "legacy-write": LegacyOutput;
  "legacy-close": LegacyOutput;
  "legacy-range": { chunks: Uint8Array[] };
}

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** The part of a Worker, a worker's global scope or a MessagePort used here. */
export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  start?(): void;
}

/** The buffers of the byte arrays in v that can move instead of being copied. */
export function transferables(v: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const visit = (v: unknown) => {
    if (v instanceof Uint8Array) {
      // A view into a larger buffer, such as WASM memory, is copied instead.
      if (v.buffer instanceof ArrayBuffer && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) {
        out.add(v.buffer);
      }
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (typeof v === "object" && v !== null) {
      Object.values(v).forEach(visit);
    }
  };
  visit(v);
  return [...out];
}

export interface Client {
  request<R extends Request>(req: R, transfer?: Transferable[]): Promise<Responses[R["op"]]>;
}

/** The page side: sends requests to a worker and resolves them by id. */
export function connect(port: Port): Client {
  let next = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  port.addEventListener("message", (e) => {
    const reply = e.data as Reply;
    const w = waiting.get(reply.id);
    if (!w) return;
    waiting.delete(reply.id);
    if (reply.ok) w.resolve(reply.result);
    else w.reject(new Error(reply.error));
  });
  port.start?.();
  return {
    request<R extends Request>(req: R, transfer: Transferable[] = []) {
      const id = next++;
      return new Promise<Responses[R["op"]]>((resolve, reject) => {
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
        port.postMessage({ ...req, id }, transfer);
      });
    },
  };
}
