// The message protocol between the page and the crypto Web Worker. Keys stay
// inside the worker: the page opens a session, streams bytes through it and
// gets back ciphertext or plaintext, the link token and the key verifier.
// Every request carries an id and gets exactly one reply with the same id.

import { ready, unwrapKey } from "../crypto";
import {
  createEncryptor,
  openKeys,
  ShareDecryptor,
  readHeader,
  decryptRange,
  type FileEntry,
  type Header,
  type ShareEncryptor,
} from "./share";
import type { ShareKeys } from "./keys";

export type Request =
  | { op: "encrypt-open"; session: number; files: FileEntry[]; password?: string }
  | { op: "encrypt-write"; session: number; data: Uint8Array }
  /** Returns the padding and final chunks, at most about maxBytes per call, until done. */
  | { op: "encrypt-close"; session: number; maxBytes?: number }
  /** Derives the keys (Argon2id in password mode) and returns the verifier for the download request. */
  | { op: "decrypt-open"; session: number; token: string; password?: string }
  | { op: "decrypt-write"; session: number; data: Uint8Array }
  | { op: "decrypt-close"; session: number }
  /** Opens the header from the blob's first headerLength bytes, for seeking. */
  | { op: "read-header"; session: number; data: Uint8Array }
  /** Decrypts [start, end] from the blob bytes cipherRange named. */
  | {
      op: "range";
      session: number;
      header: Header;
      contentOffset: number;
      start: number;
      end: number;
      data: Uint8Array;
    }
  | { op: "close"; session: number }
  /** Unwraps the key of an older password share. */
  | { op: "unwrap"; wrapped: Uint8Array; salt: Uint8Array; password: string };

export interface Responses {
  "encrypt-open": { token: string; verifier: string; blobLength: number; prefix: Uint8Array };
  "encrypt-write": { chunks: Uint8Array[] };
  "encrypt-close": { chunks: Uint8Array[]; done: boolean };
  "decrypt-open": { verifier: string };
  /** header is set once, in the reply that completed it. */
  "decrypt-write": { header: Header | null; chunks: Uint8Array[] };
  "decrypt-close": Record<string, never>;
  "read-header": { header: Header; contentOffset: number };
  range: { chunks: Uint8Array[] };
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

const DEFAULT_CLOSE_BYTES = 8 * 1024 * 1024;

type Session =
  | { kind: "encrypt"; enc: ShareEncryptor; tail?: Generator<Uint8Array> }
  | { kind: "decrypt"; keys: ShareKeys; dec: ShareDecryptor };

function transferables(result: unknown): ArrayBuffer[] {
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
  visit(result);
  return [...out];
}

/** Answers protocol requests arriving on port. Requests run one at a time, in order. */
export function serve(port: Port): void {
  const sessions = new Map<number, Session>();

  function get<K extends Session["kind"]>(id: number, kind: K): Extract<Session, { kind: K }> {
    const s = sessions.get(id);
    if (!s || s.kind !== kind) throw new Error(`no ${kind} session ${id}`);
    return s as Extract<Session, { kind: K }>;
  }

  function fresh(id: number): void {
    if (sessions.has(id)) throw new Error(`session ${id} is already open`);
  }

  async function handle(req: Request): Promise<unknown> {
    switch (req.op) {
      case "encrypt-open": {
        fresh(req.session);
        const enc = await createEncryptor(req.files, { password: req.password });
        sessions.set(req.session, { kind: "encrypt", enc });
        return { token: enc.token, verifier: enc.verifier, blobLength: enc.blobLength, prefix: enc.prefix.slice() };
      }
      case "encrypt-write":
        return { chunks: get(req.session, "encrypt").enc.push(req.data) };
      case "encrypt-close": {
        const s = get(req.session, "encrypt");
        s.tail ??= s.enc.finish();
        const limit = req.maxBytes ?? DEFAULT_CLOSE_BYTES;
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size < limit) {
          const r = s.tail.next();
          if (r.done) {
            sessions.delete(req.session);
            return { chunks, done: true };
          }
          chunks.push(r.value);
          size += r.value.length;
        }
        return { chunks, done: false };
      }
      case "decrypt-open": {
        fresh(req.session);
        const keys = await openKeys(req.token, req.password);
        sessions.set(req.session, { kind: "decrypt", keys, dec: new ShareDecryptor(keys) });
        return { verifier: keys.verifier };
      }
      case "decrypt-write": {
        const { dec } = get(req.session, "decrypt");
        const before = dec.header;
        const chunks = dec.push(req.data);
        return { header: before === null ? dec.header : null, chunks };
      }
      case "decrypt-close":
        get(req.session, "decrypt").dec.finish();
        sessions.delete(req.session);
        return {};
      case "read-header":
        return readHeader(get(req.session, "decrypt").keys, req.data);
      case "range": {
        const { keys } = get(req.session, "decrypt");
        const chunks: Uint8Array[] = [];
        const data = req.data;
        for await (const c of decryptRange(keys, req.header, req.contentOffset, async () => data, req.start, req.end)) {
          chunks.push(c);
        }
        return { chunks };
      }
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
        if ("session" in req && req.op !== "encrypt-open" && req.op !== "decrypt-open") sessions.delete(req.session);
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
