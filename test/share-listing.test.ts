import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, computeKeyVerifier, decodeKey, encodeKey, generateKey } from "../lib/e2e/crypto";
import { encryptForUpload } from "../lib/e2e/pipeline";
import { encryptFilesForUpload } from "../lib/e2e/multi-pipeline";
import { concatFiles } from "../lib/e2e/multi-file";
import { peekBlobHeader } from "../lib/e2e/blob-layout";
import { createEncryptor, encryptStream, openKeys } from "../lib/e2e/v2/share";
import { headerLength } from "../lib/e2e/v2/layout";
import {
  listShareFiles,
  listV2ShareFiles,
  fetchShareHeader,
  fetchShareListing,
  fetchLinkListing,
  openLink,
} from "../lib/e2e/share-listing";
import { cryptoWorker } from "./crypto-worker";

const worker = cryptoWorker();

before(async () => {
  await ready();
});

async function* one(b: Uint8Array) {
  yield b;
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// What GET /api/d/{slug}/header returns: the blob up to the end of enc_meta.
function headerOf(blob: Uint8Array): Uint8Array {
  return blob.subarray(0, peekBlobHeader(blob).contentOffset);
}

test("listShareFiles reads a single-file share from its header", async () => {
  const data = new Uint8Array(5000).fill(7);
  const { blob, keyForUrl } = await encryptForUpload(
    one(data),
    { name: "holiday.jpg", type: "image/jpeg", size: data.length },
    { seekable: true },
  );
  const header = headerOf(await collect(blob));

  const files = await listShareFiles(worker, header, decodeKey(keyForUrl), 2);

  assert.deepEqual(files, [{ name: "holiday.jpg", type: "image/jpeg", size: 5000 }]);
});

test("listShareFiles reads every file of a multi-file share from its header", async () => {
  const files = [
    { name: "a.txt", type: "text/plain", body: new Uint8Array(10).fill(1) },
    { name: "b.pdf", type: "application/pdf", body: new Uint8Array(300).fill(2) },
  ];
  const packed = files.map((f) => ({
    name: f.name,
    type: f.type,
    size: f.body.length,
    stream: () => one(f.body),
  }));
  const { blob, keyForUrl } = await encryptFilesForUpload(packed, concatFiles(packed));
  const header = headerOf(await collect(blob));

  assert.deepEqual(await listShareFiles(worker, header, decodeKey(keyForUrl), 3), [
    { name: "a.txt", type: "text/plain", size: 10 },
    { name: "b.pdf", type: "application/pdf", size: 300 },
  ]);
});

test("listShareFiles rejects a header under the wrong key", async () => {
  const { blob } = await encryptForUpload(one(new Uint8Array(3)), {
    name: "x",
    type: "text/plain",
  });
  const header = headerOf(await collect(blob));

  await assert.rejects(listShareFiles(worker, header, generateKey(), 2));
});

test("listShareFiles refuses a format it does not know", async () => {
  const { blob, keyForUrl } = await encryptForUpload(one(new Uint8Array(3)), {
    name: "x",
    type: "text/plain",
  });
  const header = headerOf(await collect(blob));

  await assert.rejects(listShareFiles(worker, header, decodeKey(keyForUrl), 9), /format 9/);
});

test("fetchShareHeader asks the header route with the key verifier", async () => {
  const seen: { url: string; verifier: string | null }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      verifier: new Headers(init?.headers).get("x-fd-key-verifier"),
    });
    return new Response(new Uint8Array([1, 9]), { status: 200 });
  }) as typeof fetch;

  const got = await fetchShareHeader("k7Mx9qT2", "verifier-value", fakeFetch);

  assert.deepEqual(seen, [{ url: "/api/d/k7Mx9qT2/header", verifier: "verifier-value" }]);
  assert.deepEqual(got, new Uint8Array([1, 9]));
});

test("fetchShareHeader rejects when the server refuses", async () => {
  const fakeFetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

  await assert.rejects(fetchShareHeader("slug", "v", fakeFetch), /401/);
});

test("fetchShareListing lists the files without the counted download", async () => {
  const { blob, keyForUrl } = await encryptForUpload(one(new Uint8Array(42)), {
    name: "notes.md",
    type: "text/markdown",
    size: 42,
  });
  const header = headerOf(await collect(blob));
  const key = decodeKey(keyForUrl);
  const urls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    assert.equal(new Headers(init?.headers).get("x-fd-key-verifier"), computeKeyVerifier(key));
    return new Response(new Uint8Array(header), { status: 200 });
  }) as typeof fetch;

  const files = await fetchShareListing(worker, "slug", { key, verifier: computeKeyVerifier(key) }, 2, fakeFetch);

  assert.deepEqual(urls, ["/api/d/slug/header"]);
  assert.deepEqual(files, [{ name: "notes.md", type: "text/markdown", size: 42 }]);
});

async function v2Share(files: { name: string; type: string; body: Uint8Array }[], password?: string) {
  const enc = await createEncryptor(
    files.map((f) => ({ name: f.name, type: f.type, size: f.body.length })),
    { password },
  );
  async function* plaintext() {
    for (const f of files) yield f.body;
  }
  const blob = await collect(encryptStream(enc, plaintext()));
  return { token: enc.token, verifier: enc.verifier, header: blob.subarray(0, headerLength(blob)) };
}

const bundle = [
  { name: "a.txt", type: "text/plain", body: new Uint8Array(10).fill(1) },
  { name: "b.pdf", type: "application/pdf", body: new Uint8Array(300).fill(2) },
];

test("listV2ShareFiles reads every file of a v2 share from its sealed header", async () => {
  const { token, header } = await v2Share(bundle);

  assert.deepEqual(await listV2ShareFiles(worker, header, await openKeys(token)), [
    { name: "a.txt", type: "text/plain", size: 10 },
    { name: "b.pdf", type: "application/pdf", size: 300 },
  ]);
});

test("listV2ShareFiles rejects a header under another link", async () => {
  const { header } = await v2Share(bundle);
  const other = await v2Share(bundle);

  const keys = await openKeys(other.token);

  await assert.rejects(listV2ShareFiles(worker, header, keys), /does not open/);
});

test("openLink takes the v2 path for a v2 token", async () => {
  const { token, verifier } = await v2Share(bundle);

  const link = await openLink(worker, token, 4);

  assert.equal(link.format, 4);
  assert.equal(link.format === 4 && link.keys.verifier, verifier);
});

test("openLink refuses a v2 token when the server reports an older format", async () => {
  const { token } = await v2Share(bundle);

  await assert.rejects(openLink(worker, token, 2), /format 2/);
  await assert.rejects(openLink(worker, token, 3), /format 3/);
});

test("openLink refuses a bare key for a format 4 share", async () => {
  await assert.rejects(openLink(worker, encodeKey(generateKey()), 4), /format 4/);
});

test("openLink opens a bare key for the older formats", async () => {
  const key = generateKey();

  assert.deepEqual(await openLink(worker, encodeKey(key), 3), {
    format: 3,
    key: { key, verifier: computeKeyVerifier(key) },
  });
});

test("openLink needs the password of a link-and-password token", async () => {
  const { token, verifier } = await v2Share(bundle, "correct horse battery");

  await assert.rejects(openLink(worker, token, 4), /needs a password/);
  const link = await openLink(worker, token, 4, "correct horse battery");
  assert.equal(link.format === 4 && link.keys.verifier, verifier);
});

test("fetchLinkListing lists a v2 share from the header route with its verifier", async () => {
  const { token, verifier, header } = await v2Share(bundle, "correct horse battery");
  const seen: { url: string; verifier: string | null }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, verifier: new Headers(init?.headers).get("x-fd-key-verifier") });
    return new Response(new Uint8Array(header), { status: 200 });
  }) as typeof fetch;

  const link = await openLink(worker, token, 4, "correct horse battery");
  const files = await fetchLinkListing(worker, "slug", link, fakeFetch);

  assert.deepEqual(seen, [{ url: "/api/d/slug/header", verifier }]);
  assert.deepEqual(files.map((f) => f.name), ["a.txt", "b.pdf"]);
});
