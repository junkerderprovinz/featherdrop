import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadEncrypted, type FinalizeRequest } from "../lib/e2e/upload-flow";
import {
  downloadDecryptedV2,
  fetchShareBlob,
  DownloadInProgressError,
} from "../lib/e2e/download-flow";
import { openKeys } from "../lib/e2e/v2/share";

function bytes(n: number, seed = 0): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n).map((_, i) => (i * 3 + seed) % 251);
}

async function readAll(rs: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = rs.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** A server stand-in: stores the upload and the finalize body, serves the blob for the stored verifier only. */
function fakeServer() {
  let stored: Uint8Array | null = null;
  let finalized: FinalizeRequest | null = null;
  return {
    deps: {
      baseUrl: "https://drop.example.tld",
      async upload(file: File) {
        stored = new Uint8Array(await file.arrayBuffer());
        return "upload-1";
      },
      async finalize(body: FinalizeRequest) {
        finalized = body;
        return { slug: "abc123" };
      },
    },
    get finalized() {
      return finalized;
    },
    get blob() {
      return stored;
    },
    cut(n: number) {
      if (stored) stored = stored.subarray(0, stored.length - n);
    },
    async fetchBlob(verifier: string): Promise<ReadableStream<Uint8Array>> {
      if (!stored || verifier !== finalized?.keyVerifier) throw new Error("401 unauthorized");
      const blob = stored;
      return new ReadableStream({
        start(c) {
          c.enqueue(blob);
          c.close();
        },
      });
    },
  };
}

async function download(server: ReturnType<typeof fakeServer>, url: string, password?: string) {
  const token = new URL(url).hash.replace(/^#k=/, "");
  const saved: { name: string; data: Uint8Array }[] = [];
  const { header } = await downloadDecryptedV2(
    (v) => server.fetchBlob(v),
    { token, password },
    async (plaintext, name) => {
      saved.push({ name, data: await readAll(plaintext) });
    },
  );
  return { header, saved };
}

test("format 4 uploads a single file that downloads again", async () => {
  const server = fakeServer();
  const data = bytes(70_000);
  const file = new File([data], "film.mp4", { type: "video/mp4" });
  const { shareUrl } = await uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, server.deps);

  assert.equal(server.finalized?.format, 4);
  assert.equal(server.finalized?.wrappedKey, undefined);
  assert.equal(server.finalized?.kdfSalt, undefined);
  assert.match(shareUrl, /^https:\/\/drop\.example\.tld\/d\/abc123#k=[A-Za-z0-9_-]{46}$/);

  const { header, saved } = await download(server, shareUrl);
  assert.equal(header.kind, "single");
  assert.deepEqual(saved, [{ name: "film.mp4", data }]);
});

test("format 4 uploads a bundle with a password that downloads file by file", async () => {
  const server = fakeServer();
  const a = bytes(10, 1);
  const b = bytes(5000, 2);
  const files = [new File([a], "a.txt", { type: "text/plain" }), new File([b], "b.bin")];
  const { shareUrl } = await uploadEncrypted(
    files,
    { expiry: "1d", maxDownloads: 1, password: "correct horse battery", format: 4 },
    server.deps,
  );
  assert.equal(server.finalized?.wrappedKey, undefined);

  const { header, saved } = await download(server, shareUrl, "correct horse battery");
  assert.equal(header.kind, "bundle");
  assert.equal(header.mode, "link+password");
  assert.deepEqual(saved, [
    { name: "a.txt", data: a },
    { name: "b.bin", data: b },
  ]);
});

test("a wrong password sends a verifier the server refuses", async () => {
  const server = fakeServer();
  const file = new File([bytes(100)], "x");
  const { shareUrl } = await uploadEncrypted(
    [file],
    { expiry: "1d", maxDownloads: 1, password: "correct horse battery", format: 4 },
    server.deps,
  );
  await assert.rejects(download(server, shareUrl, "wrong horse battery"), /401/);
});

test("uploads stay on the older formats unless format 4 is asked for", async () => {
  const server = fakeServer();
  await uploadEncrypted([new File([bytes(10)], "x")], { expiry: "1d", maxDownloads: null }, server.deps);
  assert.equal(server.finalized?.format, 2);
});

test("a download missing its final chunk fails even when every file byte arrived", async () => {
  const server = fakeServer();
  // 4 MiB + 64 KiB pads by exactly one chunk, so the final chunk holds only padding.
  const size = 4 * 1024 * 1024 + 65_536;
  const file = new File([bytes(size)], "x");
  const { shareUrl } = await uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, server.deps);
  server.cut(65_536 + 16);
  await assert.rejects(download(server, shareUrl), /v2: blob truncated/);
});

/** A fetch for the counted download route that serves the stored blob in small pieces. */
function servingFetch(server: ReturnType<typeof fakeServer>, status = 200) {
  const seen: { url: string; verifier: string | null }[] = [];
  let drained = false;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, verifier: new Headers(init?.headers).get("x-fd-key-verifier") });
    if (status !== 200) return new Response(JSON.stringify({ error: "download in progress" }), { status });
    const blob = server.blob!;
    let off = 0;
    return new Response(
      new ReadableStream({
        pull(c) {
          if (off >= blob.length) {
            drained = true;
            c.close();
            return;
          }
          c.enqueue(blob.slice(off, off + 1000));
          off += 1000;
        },
      }),
    );
  }) as typeof fetch;
  return {
    fetchImpl,
    seen,
    get drained() {
      return drained;
    },
  };
}

async function uploadV2(server: ReturnType<typeof fakeServer>, password?: string) {
  const data = bytes(70_000);
  const { shareUrl } = await uploadEncrypted(
    [new File([data], "film.mp4", { type: "video/mp4" })],
    { expiry: "1d", maxDownloads: 1, password, format: 4 },
    server.deps,
  );
  return { data, token: new URL(shareUrl).hash.replace(/^#k=/, "") };
}

test("a v2 download reads the response to its end, which is what the server counts", async () => {
  const server = fakeServer();
  const { data, token } = await uploadV2(server);
  const net = servingFetch(server);
  const saved: Uint8Array[] = [];

  await downloadDecryptedV2(fetchShareBlob("abc123", net.fetchImpl), { token }, async (plaintext) => {
    saved.push(await readAll(plaintext));
  });

  assert.deepEqual(net.seen, [{ url: "/api/d/abc123", verifier: server.finalized?.keyVerifier }]);
  assert.ok(net.drained);
  assert.deepEqual(saved, [data]);
});

test("a v2 download that another reader holds rejects as in progress and saves nothing", async () => {
  const server = fakeServer();
  const { token } = await uploadV2(server);
  const net = servingFetch(server, 409);
  let saves = 0;

  await assert.rejects(
    downloadDecryptedV2(fetchShareBlob("abc123", net.fetchImpl), { token }, async () => {
      saves++;
    }),
    DownloadInProgressError,
  );
  assert.equal(saves, 0);
});

test("fetchShareBlob rejects any other refusal with its status", async () => {
  const server = fakeServer();
  const net = servingFetch(server, 401);

  await assert.rejects(fetchShareBlob("abc123", net.fetchImpl)("v"), (e: unknown) => {
    assert.ok(!(e instanceof DownloadInProgressError));
    assert.match(String(e), /401/);
    return true;
  });
});

test("a v2 link-and-password download takes keys derived once for the listing", async () => {
  const server = fakeServer();
  const { data, token } = await uploadV2(server, "correct horse battery");
  const keys = await openKeys(token, "correct horse battery");
  const saved: Uint8Array[] = [];

  await downloadDecryptedV2((v) => server.fetchBlob(v), { keys }, async (plaintext) => {
    saved.push(await readAll(plaintext));
  });

  assert.deepEqual(saved, [data]);
});
