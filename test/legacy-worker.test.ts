// Formats 2 and 3 through the crypto worker, as the page runs them. The
// blobs the worker writes must be the ones the older code reads, and the
// other way round.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, generateKey } from "../lib/e2e/crypto";
import { encryptForUpload, decryptWithKey } from "../lib/e2e/pipeline";
import { encryptFilesForUpload } from "../lib/e2e/multi-pipeline";
import { concatFiles } from "../lib/e2e/multi-file";
import { peekBlobHeader } from "../lib/e2e/blob-layout";
import { fromBase64 } from "../lib/e2e/base64";
import { seekCipherByteRange } from "../lib/e2e/stream-preview";
import { encryptLegacyInWorker, decryptFileInWorker, decryptBundleInWorker } from "../lib/e2e/v2/remote";
import { cryptoWorker } from "./crypto-worker";

before(async () => {
  await ready();
});

function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + seed) % 251);
}

async function* sliced(b: Uint8Array, step = 9000) {
  for (let at = 0; at < b.length; at += step) yield b.slice(at, at + step);
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

const headerOf = (blob: Uint8Array) => blob.slice(0, peekBlobHeader(blob).contentOffset);

test("a file encrypted in the worker is a format 2 blob the older code opens", async () => {
  const worker = cryptoWorker();
  const data = bytes(200_000);
  const file = { name: "talk.mp4", type: "video/mp4", size: data.length };
  const enc = await encryptLegacyInWorker(worker, 2, [file], sliced(data));
  const blob = await collect(enc.blob);

  const key = await worker.request({ op: "legacy-key", secret: { keyFromUrl: enc.keyForUrl } });
  assert.equal(key.verifier, enc.keyVerifier);
  const { meta, plaintext } = await decryptWithKey(sliced(blob), key.key);
  assert.equal(meta.cf, 2);
  assert.deepEqual({ name: meta.name, type: meta.type, size: meta.size }, file);
  assert.deepEqual(await collect(plaintext), data);
});

test("a format 2 blob decrypts in the worker in any slicing", async () => {
  const data = bytes(150_001, 3);
  const meta = { name: "a.bin", type: "application/octet-stream", size: data.length };
  for (const seekable of [false, true]) {
    const enc = await encryptForUpload(sliced(data), meta, { seekable });
    const blob = await collect(enc.blob);
    const worker = cryptoWorker();
    const { key } = await worker.request({ op: "legacy-key", secret: { keyFromUrl: enc.keyForUrl } });
    for (const step of [1000, 70_000]) {
      const got = await decryptFileInWorker(worker, key, sliced(blob, step));
      assert.equal(got.meta.name, "a.bin");
      assert.deepEqual(await collect(got.plaintext), data, `seekable ${seekable}, step ${step}`);
    }
  }
});

test("several files encrypted in the worker come back as a format 3 bundle", async () => {
  const worker = cryptoWorker();
  const files = [
    { name: "a.txt", type: "text/plain", body: bytes(10, 1) },
    { name: "b.pdf", type: "application/pdf", body: bytes(140_000, 2) },
  ];
  const packed = files.map((f) => ({ name: f.name, type: f.type, size: f.body.length, stream: () => sliced(f.body) }));
  const entries = packed.map(({ name, type, size }) => ({ name, type, size }));
  const enc = await encryptLegacyInWorker(worker, 3, entries, concatFiles(packed));
  const blob = await collect(enc.blob);

  const { key } = await worker.request({ op: "legacy-key", secret: { keyFromUrl: enc.keyForUrl } });
  const { manifest, files: out } = await decryptBundleInWorker(worker, key, sliced(blob, 5000));
  assert.deepEqual(manifest.files, entries);
  const got: Uint8Array[] = [];
  for await (const f of out) got.push(await collect(f.bytes));
  assert.deepEqual(got, files.map((f) => f.body));
});

test("a password share's key comes from the worker with the verifier the upload stored", async () => {
  const worker = cryptoWorker();
  const data = bytes(3000);
  const enc = await encryptLegacyInWorker(worker, 2, [{ name: "x", type: "", size: data.length }], sliced(data), "hunter22");
  assert.equal(enc.keyForUrl, "");
  assert.ok(enc.wrapped);
  const { wrapped, salt } = enc.wrapped;
  const blob = await collect(enc.blob);

  const key = await worker.request({ op: "legacy-key", secret: { password: "hunter22", wrapped, salt } });
  assert.equal(key.verifier, enc.keyVerifier);
  assert.deepEqual(await collect((await decryptFileInWorker(worker, key.key, sliced(blob))).plaintext), data);
  await assert.rejects(worker.request({ op: "legacy-key", secret: { password: "hunter2", wrapped, salt } }));
});

test("the worker opens enc_meta and the manifest from a blob header", async () => {
  const worker = cryptoWorker();
  const single = await encryptForUpload(sliced(bytes(42)), { name: "notes.md", type: "text/markdown", size: 42 }, { seekable: true });
  const singleBlob = await collect(single.blob);
  const { key } = await worker.request({ op: "legacy-key", secret: { keyFromUrl: single.keyForUrl } });
  const { meta, contentOffset } = await worker.request({ op: "legacy-meta", key, data: headerOf(singleBlob) });
  assert.equal(meta.name, "notes.md");
  assert.equal(meta.size, 42);
  assert.equal(contentOffset, headerOf(singleBlob).length);

  const bundle = await encryptFilesForUpload(
    [{ name: "a", type: "text/plain", size: 3 }],
    sliced(bytes(3)),
  );
  const bundleBlob = await collect(bundle.blob);
  const bundleKey = await worker.request({ op: "legacy-key", secret: { keyFromUrl: bundle.keyForUrl } });
  const { manifest } = await worker.request({ op: "legacy-manifest", key: bundleKey.key, data: headerOf(bundleBlob) });
  assert.deepEqual(manifest.files, [{ name: "a", type: "text/plain", size: 3 }]);

  await assert.rejects(worker.request({ op: "legacy-meta", key: generateKey(), data: headerOf(singleBlob) }));
});

test("a seekable range decrypts in the worker from the chunks the page fetched", async () => {
  const worker = cryptoWorker();
  const data = bytes(400_000, 5);
  const enc = await encryptForUpload(sliced(data), { name: "v.mp4", type: "video/mp4", size: data.length }, { seekable: true });
  const blob = await collect(enc.blob);
  const { key } = await worker.request({ op: "legacy-key", secret: { keyFromUrl: enc.keyForUrl } });
  const { meta, contentOffset } = await worker.request({ op: "legacy-meta", key, data: headerOf(blob) });
  assert.ok(meta.baseNonce);
  const baseNonce = fromBase64(meta.baseNonce);

  for (const [start, end] of [[0, 99], [65_530, 200_000], [399_000, 500_000]]) {
    const range = seekCipherByteRange(start, end, data.length, contentOffset);
    assert.ok(range);
    const { chunks } = await worker.request({
      op: "legacy-range",
      key,
      baseNonce,
      size: data.length,
      start,
      end,
      data: blob.slice(range.start, range.end + 1),
    });
    assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), data.subarray(start, end + 1), `${start}-${end}`);
  }
});

test("a truncated blob fails in the worker instead of ending short", async () => {
  const worker = cryptoWorker();
  const data = bytes(100_000);
  const enc = await encryptLegacyInWorker(worker, 2, [{ name: "a", type: "", size: data.length }], sliced(data));
  const blob = await collect(enc.blob);
  const { key } = await worker.request({ op: "legacy-key", secret: { keyFromUrl: enc.keyForUrl } });

  const { plaintext } = await decryptFileInWorker(worker, key, sliced(blob.subarray(0, blob.length - 10)));
  await assert.rejects(collect(plaintext));
});
