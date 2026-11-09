// The message protocol between the page and the crypto Web Worker. The worker
// derives keys and seals and opens chunks; the page reads files, talks to the
// server and passes the bytes through. create hands the page the blob state,
// content key included, because resuming an upload after a reload needs it.
// Every request carries an id and gets exactly one reply with the same id.

import { ready, unwrapKey } from "../crypto";
import {
  createEncryptor,
  openKeys,
  ShareDecryptor,
  RangeDecryptor,
  readHeader,
  sealSpan,
  type BlobState,
  type FileEntry,
  type Header,
  type Kind,
} from "./share";
import type { ShareKeys } from "./keys";

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
  /** Unwraps the key of an older password share. */
  | { op: "unwrap"; wrapped: Uint8Array; salt: Uint8Array; password: string };

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
  unwrap: { key: Uint8Array };
}

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** The part of a Worker, a worker's global scope or a MessagePort used here. */
export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  start?(): void;
}

type Session = {
  keys: ShareKeys;
  dec: ShareDecryptor;
  seek?: { header: Header; contentOffset: number };
  range?: RangeDecryptor;
};

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

function openRange(s: Session): RangeDecryptor {
  if (!s.range) throw new Error("v2: open a range before writing to it");
  return s.range;
}

/** Answers protocol requests arriving on port. Requests run one at a time, in order. */
export function serve(port: Port): void {
  const sessions = new Map<number, Session>();

  function get(id: number): Session {
    const s = sessions.get(id);
    if (!s) throw new Error(`no decrypt session ${id}`);
    return s;
  }

  async function handle(req: Request): Promise<unknown> {
    switch (req.op) {
      case "create": {
        const enc = await createEncryptor(req.files, { password: req.password, kind: req.kind });
        return { token: enc.token, verifier: enc.verifier, state: enc.state };
      }
      case "seal":
        return { data: sealSpan(req.state, req.start, req.end, req.plain) };
      case "decrypt-open": {
        if (sessions.has(req.session)) throw new Error(`session ${req.session} is already open`);
        const keys = "keys" in req ? req.keys : await openKeys(req.token, req.password);
        sessions.set(req.session, { keys, dec: new ShareDecryptor(keys) });
        return { verifier: keys.verifier };
      }
      case "decrypt-write": {
        const { dec } = get(req.session);
        const before = dec.header;
        const chunks = dec.push(req.data);
        return { header: before === null ? dec.header : null, chunks };
      }
      case "decrypt-close":
        get(req.session).dec.finish();
        sessions.delete(req.session);
        return {};
      case "read-header": {
        const s = get(req.session);
        s.seek = readHeader(s.keys, req.data);
        return s.seek;
      }
      case "range-open": {
        const s = get(req.session);
        if (!s.seek) throw new Error("v2: read the header before seeking");
        s.range = new RangeDecryptor(s.keys, s.seek.header, s.seek.contentOffset, req.start, req.end);
        return {};
      }
      case "range-write":
        return { chunks: openRange(get(req.session)).push(req.data) };
      case "range-close":
        openRange(get(req.session)).finish();
        sessions.delete(req.session);
        return {};
      case "close":
        sessions.delete(req.session);
        return {};
      case "unwrap":
        await ready();
        return { key: unwrapKey(req.wrapped, req.salt, req.password) };
    }
  }

  let queue: Promise<void> = Promise.resolve();
  port.addEventListener("message", (e) => {
    const { id, ...req } = e.data as Request & { id: number };
    queue = queue.then(async () => {
      let reply: Reply;
      try {
        reply = { id, ok: true, result: await handle(req as Request) };
      } catch (err) {
        // A stream that failed once cannot continue.
        if ("session" in req && req.op !== "decrypt-open") sessions.delete(req.session);
        reply = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      port.postMessage(reply, reply.ok ? transferables(reply.result) : []);
    });
  });
  port.start?.();
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
