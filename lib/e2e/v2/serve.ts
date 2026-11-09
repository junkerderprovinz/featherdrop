// The worker side of ./protocol.ts. It is the only part of the client that
// loads libsodium, so the page bundles libsodium once, inside the worker.

import { ready, computeKeyVerifier, decryptMeta, decryptManifest, hashToken, type FileMeta } from "../crypto";
import { peekBlobHeader } from "../blob-layout";
import { deriveContentKey, decryptWithKey, encryptForUpload } from "../pipeline";
import { decryptBundle, encryptFilesForUpload } from "../multi-pipeline";
import { decryptSeekableRange } from "../seekable";
import type { Manifest } from "../multi-file";
import {
  createEncryptor,
  openKeys,
  ShareDecryptor,
  RangeDecryptor,
  readHeader,
  sealSpan,
} from "./share";
import { requestKeys, sealToken, openSealedToken } from "./request";
import { transferables, type LegacyOutput, type Port, type Reply, type Request } from "./protocol";
import type { Header } from "./layout";
import type { ShareKeys } from "./token";

type Session = {
  keys: ShareKeys;
  dec: ShareDecryptor;
  seek?: { header: Header; contentOffset: number };
  range?: RangeDecryptor;
};

function openRange(s: Session): RangeDecryptor {
  if (!s.range) throw new Error("v2: open a range before writing to it");
  return s.range;
}

/**
 * Feeds a pull-based stream from bytes that arrive one request at a time.
 * write and close run it until it waits for more input or ends, and return
 * what it made by then.
 */
class Pump {
  private queue: Uint8Array[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  private starve!: () => void;
  private starved!: Promise<null>;
  private output: AsyncIterator<Uint8Array> | null = null;
  private pending: Promise<IteratorResult<Uint8Array>> | null = null;

  /** The bytes given to write, in order, ending at close. */
  readonly source: AsyncIterable<Uint8Array> = this.feed();

  private async *feed(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const data = this.queue.shift();
      if (data) yield data;
      else if (this.ended) return;
      else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.starve();
        });
      }
    }
  }

  /** Sets the stream, read from source, whose output write and close return. */
  drain(output: AsyncIterable<Uint8Array>): void {
    this.output = output[Symbol.asyncIterator]();
  }

  write(data: Uint8Array): Promise<Uint8Array[]> {
    this.queue.push(data);
    return this.run();
  }

  close(): Promise<Uint8Array[]> {
    this.ended = true;
    return this.run();
  }

  private async run(): Promise<Uint8Array[]> {
    this.starved = new Promise((resolve) => (this.starve = () => resolve(null)));
    this.wake?.();
    this.wake = null;
    const out: Uint8Array[] = [];
    for (;;) {
      this.pending ??= this.output!.next();
      // Without new input the stream can only stall, so a stall ends the turn.
      const r = await Promise.race([this.pending, this.starved]);
      if (r === null) return out;
      this.pending = null;
      if (r.done) return out;
      out.push(r.value);
    }
  }
}

type Legacy = { pump: Pump; meta: FileMeta | null; manifest: Manifest | null; told: boolean };

/** Answers protocol requests arriving on port. Requests run one at a time, in order. */
export function serve(port: Port): void {
  const sessions = new Map<number, Session>();
  const legacy = new Map<number, Legacy>();

  function get(id: number): Session {
    const s = sessions.get(id);
    if (!s) throw new Error(`no decrypt session ${id}`);
    return s;
  }

  function getLegacy(id: number): Legacy {
    const s = legacy.get(id);
    if (!s) throw new Error(`no legacy session ${id}`);
    return s;
  }

  function opened(s: Legacy, chunks: Uint8Array[]): LegacyOutput {
    const first = !s.told && (s.meta !== null || s.manifest !== null);
    if (first) s.told = true;
    return { meta: first ? s.meta : null, manifest: first ? s.manifest : null, chunks };
  }

  function checkFree(id: number): void {
    if (sessions.has(id) || legacy.has(id)) throw new Error(`session ${id} is already open`);
  }

  function newLegacy(): Legacy {
    return { pump: new Pump(), meta: null, manifest: null, told: false };
  }

  async function handle(req: Request): Promise<unknown> {
    await ready();
    switch (req.op) {
      case "create": {
        const enc = await createEncryptor(req.files, { password: req.password, kind: req.kind });
        return { token: enc.token, verifier: enc.verifier, state: enc.state };
      }
      case "seal":
        return { data: sealSpan(req.state, req.start, req.end, req.plain) };
      case "decrypt-open": {
        checkFree(req.session);
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
        legacy.delete(req.session);
        return {};
      case "keys":
        return { keys: await openKeys(req.token, req.password) };
      case "header":
        return readHeader(req.keys, req.data);
      case "hash-token":
        return { hash: hashToken(req.token) };
      case "request-keys":
        return requestKeys(req.secret);
      case "seal-token":
        return { sealed: await sealToken(req.token, req.publicKey) };
      case "open-token":
        return { token: await openSealedToken(req.sealed, req.keys) };
      case "legacy-key": {
        const key = await deriveContentKey(req.secret);
        return { key, verifier: computeKeyVerifier(key) };
      }
      case "legacy-meta": {
        const { encMeta, contentOffset } = peekBlobHeader(req.data);
        return { meta: decryptMeta(encMeta, req.key), contentOffset };
      }
      case "legacy-manifest":
        return { manifest: decryptManifest<Manifest>(peekBlobHeader(req.data).encMeta, req.key) };
      case "legacy-encrypt": {
        checkFree(req.session);
        const s = newLegacy();
        const opts = { password: req.password };
        // A single file is seekable, so a large video can seek in the preview.
        const enc =
          req.format === 2
            ? await encryptForUpload(s.pump.source, req.files[0], { ...opts, seekable: true })
            : await encryptFilesForUpload(req.files, s.pump.source, opts);
        legacy.set(req.session, s);
        s.pump.drain(enc.blob);
        return { keyForUrl: enc.keyForUrl, wrapped: enc.wrapped, keyVerifier: enc.keyVerifier };
      }
      case "legacy-decrypt": {
        checkFree(req.session);
        const s = newLegacy();
        legacy.set(req.session, s);
        const { format, key } = req;
        s.pump.drain(
          (async function* () {
            if (format === 2) {
              const { meta, plaintext } = await decryptWithKey(s.pump.source, key);
              s.meta = meta;
              yield* plaintext;
            } else {
              const { manifest, plaintext } = await decryptBundle(s.pump.source, key);
              s.manifest = manifest;
              yield* plaintext;
            }
          })(),
        );
        return {};
      }
      case "legacy-write": {
        const s = getLegacy(req.session);
        return opened(s, await s.pump.write(req.data));
      }
      case "legacy-close": {
        const s = getLegacy(req.session);
        const out = opened(s, await s.pump.close());
        legacy.delete(req.session);
        return out;
      }
      case "legacy-range": {
        const chunks: Uint8Array[] = [];
        const plain = decryptSeekableRange(async () => req.data, req.key, req.baseNonce, req.size, req.start, req.end);
        for await (const c of plain) chunks.push(c);
        return { chunks };
      }
    }
  }

  const opens = new Set<Request["op"]>(["decrypt-open", "legacy-encrypt", "legacy-decrypt"]);
  let queue: Promise<void> = Promise.resolve();
  port.addEventListener("message", (e) => {
    const { id, ...req } = e.data as Request & { id: number };
    queue = queue.then(async () => {
      let reply: Reply;
      try {
        reply = { id, ok: true, result: await handle(req as Request) };
      } catch (err) {
        // A stream that failed once cannot continue.
        if ("session" in req && !opens.has(req.op)) {
          sessions.delete(req.session);
          legacy.delete(req.session);
        }
        reply = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      port.postMessage(reply, reply.ok ? transferables(reply.result) : []);
    });
  });
  port.start?.();
}
