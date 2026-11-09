import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, computeKeyVerifier, decodeKey, generateKey } from "../lib/e2e/crypto";
import { encryptForUpload } from "../lib/e2e/pipeline";
import { encryptFilesForUpload } from "../lib/e2e/multi-pipeline";
import { peekBlobHeader } from "../lib/e2e/blob-layout";
import {
  listShareFiles,
  fetchShareHeader,
  fetchShareListing,
} from "../lib/e2e/share-listing";

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

  const files = listShareFiles(header, decodeKey(keyForUrl), 2);

  assert.deepEqual(files, [{ name: "holiday.jpg", type: "image/jpeg", size: 5000 }]);
});

test("listShareFiles reads every file of a multi-file share from its header", async () => {
  const files = [
    { name: "a.txt", type: "text/plain", body: new Uint8Array(10).fill(1) },
    { name: "b.pdf", type: "application/pdf", body: new Uint8Array(300).fill(2) },
  ];
  const { blob, keyForUrl } = await encryptFilesForUpload(
    files.map((f) => ({
      name: f.name,
      type: f.type,
      size: f.body.length,
      stream: () => one(f.body),
    })),
  );
  const header = headerOf(await collect(blob));

  assert.deepEqual(listShareFiles(header, decodeKey(keyForUrl), 3), [
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

  assert.throws(() => listShareFiles(header, generateKey(), 2));
});

test("listShareFiles refuses a format it does not know", async () => {
  const { blob, keyForUrl } = await encryptForUpload(one(new Uint8Array(3)), {
    name: "x",
    type: "text/plain",
  });
  const header = headerOf(await collect(blob));

  assert.throws(() => listShareFiles(header, decodeKey(keyForUrl), 9), /format 9/);
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

  const files = await fetchShareListing("slug", key, 2, fakeFetch);

  assert.deepEqual(urls, ["/api/d/slug/header"]);
  assert.deepEqual(files, [{ name: "notes.md", type: "text/markdown", size: 42 }]);
});
