import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createRequest,
  parseRequestUrl,
  parseCollectUrl,
  requestUrl,
  fetchRequestInfo,
  sendToRequest,
  listRequestUploads,
  fetchUploadBlob,
  closeRequest,
  deleteRequestUpload,
  RequestClosedError,
  RequestTooLargeError,
  type CollectedUpload,
} from "../lib/e2e/request-flow";
import { downloadDecryptedV2 } from "../lib/e2e/download-flow";
import { readNote } from "../lib/e2e/note";
import { headerLength } from "../lib/e2e/v2/share";
import type { UploadSource } from "../lib/e2e/upload-flow";
import { recordingWorker } from "./crypto-worker";
import { readZip } from "./zip-reader";

interface StoredRequest {
  body: Record<string, unknown>;
  uploads: { id: string; blob: Uint8Array; sealedKey: string; size: number; createdAt: number }[];
}

// An in-memory stand-in for the request routes. It checks the proofs the way
// the server does: the public key for uploaders, the collect token's hash for
// the requester.
function fakeServer(limits: { maxSize?: number; open?: boolean } = {}) {
  const requests = new Map<string, StoredRequest>();
  const tus = new Map<string, Uint8Array>();
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const notFound = () => json({ error: "not found" }, 404);
  const hash = (s: string) => createHash("sha256").update(s).digest("base64url");

  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "https://drop.example");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    seen.push({ url: url.pathname, headers, body });
    if (method === "POST" && url.pathname === "/api/requests") {
      const slug = `req${requests.size}`;
      requests.set(slug, { body: JSON.parse(body), uploads: [] });
      return json({ slug });
    }
    const m = url.pathname.match(/^\/api\/r\/([^/]+)(\/uploads(?:\/([^/]+)(\/header)?)?)?$/);
    const req = m && requests.get(m[1]);
    if (!m || !req) return notFound();
    const uploader = headers.get("x-fd-request-key") === req.body.publicKey;
    const collector = hash(headers.get("x-fd-collect-token") ?? "") === req.body.collectTokenHash;
    if (method === "GET" && !m[2]) {
      if (!uploader) return notFound();
      return json({ expiresAt: 1, maxSize: limits.maxSize ?? null, open: limits.open ?? true });
    }
    if (method === "POST" && m[2] && !m[3]) {
      if (!uploader) return notFound();
      const { uploadId, sealedKey } = JSON.parse(body);
      const blob = tus.get(uploadId)!;
      req.uploads.push({ id: `u${req.uploads.length}`, blob, sealedKey, size: blob.length, createdAt: 7 });
      return new Response(null, { status: 204 });
    }
    if (!collector) return notFound();
    if (method === "DELETE" && !m[2]) {
      requests.delete(m[1]);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && m[2] && !m[3]) {
      return json({
        expiresAt: 1,
        maxUploads: null,
        maxSize: null,
        uploads: req.uploads.map(({ id, size, createdAt, sealedKey }) => ({ id, size, createdAt, sealedKey })),
      });
    }
    const up = req.uploads.find((u) => u.id === m[3]);
    if (!up) return notFound();
    if (method === "DELETE") {
      req.uploads = req.uploads.filter((u) => u !== up);
      return new Response(null, { status: 204 });
    }
    if (m[4]) return new Response(up.blob.slice(0, headerLength(up.blob)));
    return new Response(up.blob.slice());
  }) as typeof fetch;

  const upload = async (source: UploadSource, opts: { headers: Record<string, string> }) => {
    seen.push({ url: "/files", headers: new Headers(opts.headers), body: "" });
    const id = `tus${tus.size}`;
    tus.set(id, new Uint8Array(await new Blob([(await source.slice(0, source.size)) as BlobPart]).arrayBuffer()));
    return id;
  };
  const worker = recordingWorker();
  return { fetchImpl, upload, requests, seen, crypto: worker.client, ops: worker.ops };
}

const BASE = "https://drop.example";

function opened(up: CollectedUpload) {
  assert.ok(up.readable, `upload ${up.id} does not open`);
  return up;
}

function file(name: string, data: Uint8Array, type = "application/octet-stream"): File {
  return new File([data as Uint8Array<ArrayBuffer>], name, { type });
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("files sent to a request come back through the collect link", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "7d", maxUploads: 5, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  assert.match(links.requestUrl, /^https:\/\/drop\.example\/r\/req0#p=[A-Za-z0-9_-]{46}$/);
  assert.match(links.collectUrl, /^https:\/\/drop\.example\/c\/req0#c=[A-Za-z0-9_-]{46}$/);

  const a = new Uint8Array(70_000).map((_, i) => i % 251);
  const b = new TextEncoder().encode("second file");
  const link = parseRequestUrl(links.requestUrl);
  await sendToRequest([file("a.bin", a), file("b.txt", b, "text/plain")], link, { upload: srv.upload, crypto: srv.crypto, fetchImpl: srv.fetchImpl });

  const collect = parseCollectUrl(links.collectUrl);
  const listing = await listRequestUploads(collect, srv.fetchImpl);
  assert.equal(listing.uploads.length, 1);
  const up = opened(listing.uploads[0]);
  assert.deepEqual(
    up.header.files.map((f) => [f.name, f.size]),
    [["a.bin", a.length], ["b.txt", b.length]],
  );

  let zip: { name: string; bytes: Uint8Array } | null = null;
  await downloadDecryptedV2(srv.crypto, fetchUploadBlob(collect, up.id, srv.fetchImpl), { keys: up.keys }, async (s, name) => {
    zip = { name, bytes: await bytesOf(s) };
  });
  assert.equal(zip!.name, "files.zip");
  const entries = readZip(zip!.bytes);
  assert.deepEqual(entries.map((e) => e.name), ["a.bin", "b.txt"]);
  assert.ok(Buffer.from(entries[0].data!).equals(Buffer.from(a)), "a.bin differs");
  assert.ok(Buffer.from(entries[1].data!).equals(Buffer.from(b)), "b.txt differs");
});

test("a note sent to a request is read as a note", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  await sendToRequest("the code is 4711", parseRequestUrl(links.requestUrl), { upload: srv.upload, crypto: srv.crypto, fetchImpl: srv.fetchImpl });
  const collect = parseCollectUrl(links.collectUrl);
  const up = opened((await listRequestUploads(collect, srv.fetchImpl)).uploads[0]);
  assert.equal(up.header.kind, "text");
  assert.equal(await readNote(srv.crypto, fetchUploadBlob(collect, up.id, srv.fetchImpl), { keys: up.keys }), "the code is 4711");
});

test("files sent to a request are sealed in the crypto worker", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  await sendToRequest([file("x.bin", new Uint8Array(70_000))], parseRequestUrl(links.requestUrl), {
    upload: srv.upload,
    crypto: srv.crypto,
    fetchImpl: srv.fetchImpl,
  });
  assert.deepEqual([...new Set(srv.ops)], ["create", "seal"]);
});

test("creating a request sends the public key and the collect hash, never the secret", async () => {
  const srv = fakeServer();
  const links = await createRequest(
    { expiry: "1d", maxUploads: 3, maxSize: 10_000 },
    { baseUrl: BASE, fetchImpl: srv.fetchImpl, uploadToken: "letmein" },
  );
  const sent = srv.seen[0];
  assert.equal(sent.headers.get("x-fd-upload-token"), "letmein");
  const body = JSON.parse(sent.body);
  assert.deepEqual(Object.keys(body).sort(), ["collectTokenHash", "expiry", "maxSize", "maxUploads", "publicKey"]);
  assert.equal(body.maxUploads, 3);
  assert.equal(body.maxSize, 10_000);
  const secret = new URL(links.collectUrl).hash.slice(3);
  assert.ok(!sent.body.includes(secret));
  assert.ok(!sent.body.includes(Buffer.from(parseCollectUrl(links.collectUrl).secret).toString("base64url")));
});

test("the uploader sends the request key with every request and nothing that collects", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  const link = parseRequestUrl(links.requestUrl);
  const before = srv.seen.length;
  await sendToRequest([file("x.bin", new Uint8Array(10))], link, { upload: srv.upload, crypto: srv.crypto, fetchImpl: srv.fetchImpl });
  const uploaderCalls = srv.seen.slice(before);
  assert.ok(uploaderCalls.length >= 3);
  for (const call of uploaderCalls) {
    assert.equal(call.headers.get("x-fd-request-key"), srv.requests.get("req0")!.body.publicKey);
    assert.equal(call.headers.get("x-fd-collect-token"), null);
  }
  assert.equal(uploaderCalls.find((c) => c.url === "/files")!.headers.get("x-fd-request"), "req0");
});

test("a request link is no collect link", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  assert.throws(() => parseCollectUrl(links.requestUrl), /collect link/);
  assert.throws(() => parseRequestUrl(links.collectUrl), /request link/);
  assert.throws(() => parseRequestUrl(`${BASE}/r/req0`), /request link/);
});

test("the collect link rebuilds the request link", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  assert.equal(await requestUrl(BASE, parseCollectUrl(links.collectUrl)), links.requestUrl);
});

test("an upload over the request's size cap is refused before it is sent", async () => {
  const srv = fakeServer({ maxSize: 8000 });
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: 8000 }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  const link = parseRequestUrl(links.requestUrl);
  await assert.rejects(
    sendToRequest([file("big.bin", new Uint8Array(9000))], link, { upload: srv.upload, crypto: srv.crypto, fetchImpl: srv.fetchImpl }),
    RequestTooLargeError,
  );
  assert.ok(!srv.seen.some((c) => c.url === "/files"));
});

test("a closed request refuses before anything is encrypted", async () => {
  const srv = fakeServer({ open: false });
  const links = await createRequest({ expiry: "1d", maxUploads: 1, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  const link = parseRequestUrl(links.requestUrl);
  assert.deepEqual(await fetchRequestInfo(link, srv.fetchImpl), { expiresAt: 1, maxSize: null, open: false });
  await assert.rejects(
    sendToRequest([file("x.bin", new Uint8Array(1))], link, { upload: srv.upload, crypto: srv.crypto, fetchImpl: srv.fetchImpl }),
    RequestClosedError,
  );
});

test("closing a request needs the collect link", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  assert.equal(await closeRequest(parseCollectUrl(links.collectUrl), srv.fetchImpl), "closed");
  assert.equal(srv.requests.size, 0);
  assert.equal(await closeRequest(parseCollectUrl(links.collectUrl), srv.fetchImpl), "notfound");
});

test("an upload that does not open is listed as unreadable and can be deleted", async () => {
  const srv = fakeServer();
  const links = await createRequest({ expiry: "1d", maxUploads: null, maxSize: null }, { baseUrl: BASE, fetchImpl: srv.fetchImpl });
  const link = parseRequestUrl(links.requestUrl);
  await sendToRequest([file("good.bin", new Uint8Array(5))], link, { upload: srv.upload, crypto: srv.crypto, fetchImpl: srv.fetchImpl });
  // Anyone with the request link can attach a sealed key that opens nothing.
  const good = srv.requests.get("req0")!.uploads[0];
  srv.requests.get("req0")!.uploads.unshift({
    ...good,
    id: "junk",
    sealedKey: Buffer.from(new Uint8Array(82).fill(9)).toString("base64"),
  });

  const collect = parseCollectUrl(links.collectUrl);
  const { uploads } = await listRequestUploads(collect, srv.fetchImpl);
  assert.deepEqual(uploads.map((u) => [u.id, u.readable]), [["junk", false], [good.id, true]]);
  assert.equal(opened(uploads[1]).header.files[0].name, "good.bin");

  assert.equal(await deleteRequestUpload(collect, "junk", srv.fetchImpl), "deleted");
  assert.deepEqual((await listRequestUploads(collect, srv.fetchImpl)).uploads.map((u) => u.id), [good.id]);
  assert.equal(await deleteRequestUpload(collect, "junk", srv.fetchImpl), "notfound");
});
