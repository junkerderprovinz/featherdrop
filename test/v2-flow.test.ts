import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadEncrypted, type FinalizeRequest, type UploadSource } from "../lib/e2e/upload-flow";
import {
  downloadDecryptedV2,
  downloadFileV2,
  fetchShareBlob,
  DownloadInProgressError,
} from "../lib/e2e/download-flow";
import { openKeys, decryptShare, headerLength, readHeader, cipherRange } from "../lib/e2e/v2/share";
import { readZip } from "./zip-reader";


async function* one(b: Uint8Array) {
  yield b;
}

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

async function readSource(source: UploadSource): Promise<Uint8Array> {
  return new Uint8Array(await new Blob([(await source.slice(0, source.size)) as BlobPart]).arrayBuffer());
}

/** A server stand-in: stores the upload and the finalize body, serves the blob for the stored verifier only. */
function fakeServer() {
  let stored: Uint8Array | null = null;
  let finalized: FinalizeRequest | null = null;
  return {
    deps: {
      baseUrl: "https://drop.example.tld",
      async upload(source: UploadSource) {
        stored = await readSource(source);
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
  const sizes: number[] = [];
  const { header } = await downloadDecryptedV2(
    (v) => server.fetchBlob(v),
    { token, password },
    async (plaintext, name, size) => {
      saved.push({ name, data: await readAll(plaintext) });
      sizes.push(size);
    },
    "share.zip",
  );
  return { header, saved, sizes };
}

function unzipped(zip: Uint8Array) {
  return readZip(zip).map((e) => ({ name: e.name, data: e.data }));
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

  const { header, saved, sizes } = await download(server, shareUrl);
  assert.equal(header.kind, "single");
  assert.deepEqual(saved, [{ name: "film.mp4", data }]);
  assert.deepEqual(sizes, [data.length]);
});

test("format 4 uploads a bundle with a password that downloads as one ZIP", async () => {
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

  const { header, saved, sizes } = await download(server, shareUrl, "correct horse battery");
  assert.equal(header.kind, "bundle");
  assert.equal(header.mode, "link+password");
  assert.deepEqual(
    saved.map((s) => s.name),
    ["share.zip"],
  );
  assert.equal(sizes[0], saved[0].data.length);
  assert.deepEqual(unzipped(saved[0].data), [
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

/** A save like streamToDownload: it hands the stream on and resolves before anything is read. */
function earlySave() {
  const reads: Promise<{ name: string; data: Uint8Array }>[] = [];
  return {
    reads,
    save: async (plaintext: ReadableStream<Uint8Array>, name: string) => {
      reads.push(new Promise((r) => setTimeout(r, 5)).then(async () => ({ name, data: await readAll(plaintext) })));
    },
  };
}

test("a single file arrives whole through a save that resolves before reading", async () => {
  const server = fakeServer();
  const { data, token } = await uploadV2(server);
  const { reads, save } = earlySave();

  await downloadDecryptedV2((v) => server.fetchBlob(v), { token }, save);

  assert.deepEqual(await Promise.all(reads), [{ name: "film.mp4", data }]);
});

test("a bundle's ZIP arrives whole through a save that resolves before reading", async () => {
  const server = fakeServer();
  const a = bytes(70_000, 1);
  const b = bytes(5000, 2);
  const { shareUrl } = await uploadEncrypted(
    [new File([a], "a.bin"), new File([b], "b.bin")],
    { expiry: "1d", maxDownloads: null, format: 4 },
    server.deps,
  );
  const { reads, save } = earlySave();

  await downloadDecryptedV2((v) => server.fetchBlob(v), { token: new URL(shareUrl).hash.slice(3) }, save, "s.zip");

  const [zip] = await Promise.all(reads);
  assert.equal(zip.name, "s.zip");
  assert.deepEqual(unzipped(zip.data), [
    { name: "a.bin", data: a },
    { name: "b.bin", data: b },
  ]);
});

test("a bundle's ZIP fails instead of ending when the final chunk is missing", async () => {
  const server = fakeServer();
  const size = 4 * 1024 * 1024 + 65_536;
  const { shareUrl } = await uploadEncrypted(
    [new File([bytes(size - 10)], "x"), new File([bytes(10)], "y")],
    { expiry: "1d", maxDownloads: null, format: 4 },
    server.deps,
  );
  server.cut(65_536 + 16);
  const { reads, save } = earlySave();

  await assert.rejects(
    downloadDecryptedV2((v) => server.fetchBlob(v), { token: new URL(shareUrl).hash.slice(3) }, save, "s.zip"),
    /v2: blob truncated/,
  );
  await assert.rejects(reads[0], /v2: blob truncated/);
});

test("the last file's stream fails instead of ending when the final chunk is missing", async () => {
  const server = fakeServer();
  const size = 4 * 1024 * 1024 + 65_536;
  const { shareUrl } = await uploadEncrypted(
    [new File([bytes(size)], "x")],
    { expiry: "1d", maxDownloads: null, format: 4 },
    server.deps,
  );
  server.cut(65_536 + 16);
  const { reads, save } = earlySave();

  await assert.rejects(
    downloadDecryptedV2((v) => server.fetchBlob(v), { token: new URL(shareUrl).hash.slice(3) }, save),
    /v2: blob truncated/,
  );
  await assert.rejects(reads[0], /v2: blob truncated/);
});

/** A file whose bytes are zeros made up on demand, so its size costs no memory. */
class ZeroFile extends File {
  slices = 0;
  readonly zeros: number;
  constructor(zeros: number, name: string) {
    super([], name);
    this.zeros = zeros;
  }
  override get size(): number {
    return this.zeros;
  }
  override slice(start = 0, end = this.zeros): Blob {
    this.slices++;
    return new Blob([new Uint8Array(Math.max(0, Math.min(end, this.zeros) - start))]);
  }
}

test("a format 4 upload hands over the exact blob length before reading any plaintext", async () => {
  const file = new ZeroFile(3 * 1024 * 1024, "big.bin");
  let declared = 0;
  let readBefore = -1;
  let blob: Uint8Array = new Uint8Array(0);
  const { shareUrl } = await uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, {
    baseUrl: "https://drop.example.tld",
    async upload(source) {
      declared = source.size;
      readBefore = file.slices;
      blob = await readSource(source);
      return "upload-1";
    },
    finalize: async () => ({ slug: "abc123" }),
  });

  assert.equal(readBefore, 0);
  assert.equal(declared, blob.length);
  const keys = await openKeys(new URL(shareUrl).hash.slice(3));
  const { header, plaintext } = await decryptShare(one(blob), keys);
  let size = 0;
  for await (const p of plaintext) size += p.length;
  assert.equal(header.files[0].name, "big.bin");
  assert.equal(size, file.size);
});

test("a format 4 upload larger than the in-memory cap needs no scratch storage", async () => {
  const file = new ZeroFile(600 * 1024 * 1024, "huge.bin");
  let tail: Uint8Array = new Uint8Array(0);
  await uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, {
    baseUrl: "https://drop.example.tld",
    async upload(source) {
      tail = await readSource({ size: source.size, slice: (s, e) => source.slice(s + source.size - 100, e + source.size - 100) });
      return "upload-1";
    },
    finalize: async () => ({ slug: "abc123" }),
  });
  assert.equal(tail.length, 100);
});

/** The share routes a single-file pick uses: the uncounted header and the ranged preview read. */
function rangeFetch(server: ReturnType<typeof fakeServer>, previewStatus = 206) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const blob = server.blob!;
    if (headers.get("x-fd-key-verifier") !== server.finalized?.keyVerifier) return new Response(null, { status: 401 });
    if (url === "/api/d/abc123/header") {
      seen.push("header");
      return new Response(blob.slice(0, headerLength(blob)));
    }
    if (url === "/api/d/abc123?preview=1") {
      const range = headers.get("range") ?? "";
      seen.push(`preview ${range}`);
      if (previewStatus !== 206) return new Response(null, { status: previewStatus });
      const [from, to] = range.replace("bytes=", "").split("-").map(Number);
      const body = blob.slice(from, to + 1);
      let off = 0;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (off >= body.length) return c.close();
            c.enqueue(body.slice(off, off + 777));
            off += 777;
          },
        }),
        { status: 206 },
      );
    }
    seen.push(`unexpected ${url}`);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function uploadBundle(server: ReturnType<typeof fakeServer>, files: { name: string; data: Uint8Array }[]) {
  const { shareUrl } = await uploadEncrypted(
    files.map((f) => new File([f.data as Uint8Array<ArrayBuffer>], f.name)),
    { expiry: "1d", maxDownloads: null, format: 4 },
    server.deps,
  );
  return openKeys(new URL(shareUrl).hash.slice(3));
}

test("one file of a bundle downloads alone through the uncounted range read", async () => {
  const server = fakeServer();
  const files = [
    { name: "a.bin", data: bytes(100_000, 1) },
    { name: "b.bin", data: bytes(150_000, 2) },
    { name: "c.bin", data: bytes(30_000, 3) },
  ];
  const keys = await uploadBundle(server, files);
  const net = rangeFetch(server);
  const saved: { name: string; size: number; data: Uint8Array }[] = [];

  await downloadFileV2("abc123", keys, 1, async (plaintext, name, size) => {
    saved.push({ name, size, data: await readAll(plaintext) });
  }, net.fetchImpl);

  assert.deepEqual(saved, [{ name: "b.bin", size: 150_000, data: files[1].data }]);
  const { header, contentOffset } = readHeader(keys, server.blob!);
  const plan = cipherRange(header, contentOffset, 100_000, 249_999)!;
  assert.deepEqual(net.seen, ["header", `preview bytes=${plan.from}-${plan.to}`]);
});

test("an empty file of a bundle downloads without reading any content", async () => {
  const server = fakeServer();
  const keys = await uploadBundle(server, [
    { name: "a.bin", data: bytes(10) },
    { name: "empty.txt", data: new Uint8Array(0) },
  ]);
  const net = rangeFetch(server);
  const saved: { name: string; data: Uint8Array }[] = [];

  await downloadFileV2("abc123", keys, 1, async (plaintext, name) => {
    saved.push({ name, data: await readAll(plaintext) });
  }, net.fetchImpl);

  assert.deepEqual(saved, [{ name: "empty.txt", data: new Uint8Array(0) }]);
  assert.deepEqual(net.seen, ["header"]);
});

test("a single-file pick fails when the server refuses the range read", async () => {
  const server = fakeServer();
  const keys = await uploadBundle(server, [
    { name: "a.bin", data: bytes(10) },
    { name: "b.bin", data: bytes(10) },
  ]);
  const net = rangeFetch(server, 404);
  let saves = 0;

  await assert.rejects(
    downloadFileV2("abc123", keys, 0, async () => {
      saves++;
    }, net.fetchImpl),
    /range read 404/,
  );
  assert.equal(saves, 0);
});
