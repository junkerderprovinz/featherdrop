import { test } from "node:test";
import assert from "node:assert/strict";
import { ready, wrapKey } from "../lib/e2e/crypto";
import { type Client } from "../lib/e2e/v2/protocol";
import { deriveKeys } from "../lib/e2e/v2/keys";
import {
  buildEncryptor,
  encryptStream,
  blobLength,
  plainSpan,
  cipherRange,
  openKeys,
  type BlobState,
  type Header,
} from "../lib/e2e/v2/share";
import { cryptoWorker as pair } from "./crypto-worker";

function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 5 + seed) % 251);
}
const join = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

async function* one(b: Uint8Array) {
  yield b;
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return join(parts);
}

/** Seals the whole blob of state in the worker, step bytes per request. */
async function sealVia(client: Client, state: BlobState, data: Uint8Array, step: number) {
  const parts: Uint8Array[] = [];
  const size = blobLength(state);
  for (let at = 0; at < size; at += step) {
    const span = plainSpan(state, at, at + step);
    const plain = data.slice(span.from, Math.max(span.from, span.to));
    parts.push((await client.request({ op: "seal", state, start: at, end: Math.min(at + step, size), plain }, [plain.buffer])).data);
  }
  return join(parts);
}

async function encryptVia(client: Client, data: Uint8Array, files: { name: string; type: string; size: number }[], password?: string) {
  const { token, verifier, state } = await client.request({ op: "create", files, password });
  return { blob: await sealVia(client, state, data, 70_000), token, verifier, state };
}

async function decryptVia(client: Client, blob: Uint8Array, token: string, password?: string) {
  const { verifier } = await client.request({ op: "decrypt-open", session: 2, token, password });
  let header: Header | null = null;
  const out: Uint8Array[] = [];
  for (let i = 0; i < blob.length; i += 30_000) {
    const r = await client.request({ op: "decrypt-write", session: 2, data: blob.slice(i, i + 30_000) });
    if (r.header) {
      assert.equal(header, null, "the header arrives once");
      header = r.header;
    }
    out.push(...r.chunks);
  }
  await client.request({ op: "decrypt-close", session: 2 });
  return { verifier, header, plain: join(out) };
}

test("a bundle encrypts and decrypts through the worker protocol", async () => {
  const client = pair();
  const data = bytes(150_000);
  const files = [
    { name: "a", type: "", size: 100_000 },
    { name: "b", type: "", size: 50_000 },
  ];
  const enc = await encryptVia(client, data, files);
  const dec = await decryptVia(client, enc.blob, enc.token);
  assert.equal(dec.verifier, enc.verifier);
  assert.deepEqual(dec.header?.files, files);
  assert.deepEqual(dec.plain, data);
});

test("link and password mode works through the worker protocol", async () => {
  const client = pair();
  const data = bytes(1000);
  const files = [{ name: "a", type: "", size: 1000 }];
  const enc = await encryptVia(client, data, files, "correct horse battery");
  const dec = await decryptVia(client, enc.blob, enc.token, "correct horse battery");
  assert.deepEqual(dec.plain, data);
});

test("a wrong password gives a different verifier and an error, not plaintext", async () => {
  const client = pair();
  const files = [{ name: "a", type: "", size: 10 }];
  const enc = await encryptVia(client, bytes(10), files, "correct horse battery");
  await assert.rejects(decryptVia(client, enc.blob, enc.token, "wrong horse battery"), /header/);
  const { verifier } = await client.request({
    op: "decrypt-open",
    session: 3,
    token: enc.token,
    password: "wrong horse battery",
  });
  assert.notEqual(verifier, enc.verifier);
});

test("slices sealed in the worker equal the streamed blob", async () => {
  const keys = await deriveKeys({ mode: "link", secret: new Uint8Array(32).fill(3) });
  const data = bytes(4096 * 9 + 123, 4);
  const make = () =>
    buildEncryptor({
      keys,
      kind: "single",
      files: [{ name: "a.bin", type: "", size: data.length }],
      chunk: 4096,
      headerNonce: new Uint8Array(24).fill(5),
      baseNonce: new Uint8Array(24).fill(6),
    });
  const streamed = await collect(encryptStream(make(), one(data)));
  const client = pair();
  for (const step of [1, 999, 4112, 50_000]) {
    assert.deepEqual(await sealVia(client, make().state, data, step), streamed, `step ${step}`);
  }
});

test("a share created in the worker opens with its token", async () => {
  const client = pair();
  const data = bytes(5000);
  const files = [{ name: "a.txt", type: "text/plain", size: data.length }];
  const enc = await encryptVia(client, data, files);
  assert.equal(enc.blob.length, blobLength(enc.state));
  assert.equal(enc.state.header.kind, "single");
  assert.equal((await openKeys(enc.token)).verifier, enc.verifier);
  assert.deepEqual((await decryptVia(client, enc.blob, enc.token)).plain, data);
});

test("a share created in the worker takes the kind it is asked for", async () => {
  const client = pair();
  const { state } = await client.request({
    op: "create",
    files: [{ name: "", type: "text/plain; charset=utf-8", size: 3 }],
    kind: "text",
  });
  assert.equal(state.header.kind, "text");
});

test("a decrypt session opens with keys derived on the page", async () => {
  const client = pair();
  const data = bytes(9000, 2);
  const enc = await encryptVia(client, data, [{ name: "a", type: "", size: data.length }], "correct horse battery");
  const keys = await openKeys(enc.token, "correct horse battery");
  const { verifier } = await client.request({ op: "decrypt-open", session: 6, keys });
  assert.equal(verifier, enc.verifier);
  const r = await client.request({ op: "decrypt-write", session: 6, data: enc.blob });
  await client.request({ op: "decrypt-close", session: 6 });
  assert.deepEqual(join(r.chunks), data);
});

async function seekable(client: Client, session: number, size: number) {
  const data = bytes(size, 7);
  const enc = await encryptVia(client, data, [{ name: "v.mp4", type: "video/mp4", size }]);
  await client.request({ op: "decrypt-open", session, token: enc.token });
  const prefixLen = 5 + new DataView(enc.blob.buffer).getUint32(1);
  const { header, contentOffset } = await client.request({ op: "read-header", session, data: enc.blob.slice(0, prefixLen) });
  return { data, enc, header, contentOffset };
}

test("a seek decrypts the requested range from the fetched chunks in any slicing", async () => {
  const client = pair();
  const { data, enc, header, contentOffset } = await seekable(client, 4, 300_000);
  const start = 140_000;
  const end = 150_000;
  const plan = cipherRange(header, contentOffset, start, end);
  assert.ok(plan);
  await client.request({ op: "range-open", session: 4, start, end });
  const out: Uint8Array[] = [];
  for (let at = plan.from; at <= plan.to; at += 3000) {
    const part = enc.blob.slice(at, Math.min(at + 3000, plan.to + 1));
    out.push(...(await client.request({ op: "range-write", session: 4, data: part }, [part.buffer])).chunks);
  }
  await client.request({ op: "range-close", session: 4 });
  assert.deepEqual(join(out), data.subarray(start, end + 1));
});

test("a seek whose chunks stop short is an error", async () => {
  const client = pair();
  const { enc, header, contentOffset } = await seekable(client, 7, 100_000);
  const plan = cipherRange(header, contentOffset, 0, 99_999);
  assert.ok(plan);
  await client.request({ op: "range-open", session: 7, start: 0, end: 99_999 });
  await client.request({ op: "range-write", session: 7, data: enc.blob.slice(plan.from, plan.to - 10) });
  await assert.rejects(client.request({ op: "range-close", session: 7 }), /length/);
});

test("a seek before the worker opened the header is refused", async () => {
  const client = pair();
  const size = 10_000;
  const enc = await encryptVia(client, bytes(size), [{ name: "v.mp4", type: "video/mp4", size }]);
  await client.request({ op: "decrypt-open", session: 5, token: enc.token });

  await assert.rejects(client.request({ op: "range-open", session: 5, start: 0, end: 99 }), /header/);
});

test("an unknown session is an error", async () => {
  const client = pair();
  await assert.rejects(client.request({ op: "decrypt-write", session: 99, data: new Uint8Array(1) }), /session/);
});

test("an old password share unwraps in the worker", async () => {
  await ready();
  const key = new Uint8Array(32).fill(4);
  const { wrapped, salt } = wrapKey(key, "old password");
  const client = pair();
  const r = await client.request({ op: "unwrap", wrapped, salt, password: "old password" });
  assert.deepEqual(r.key, key);
  await assert.rejects(client.request({ op: "unwrap", wrapped, salt, password: "wrong" }));
});
