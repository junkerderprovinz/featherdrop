import { test } from "node:test";
import assert from "node:assert/strict";
import {
  uploadEncrypted,
  resumeUpload,
  type FinalizeRequest,
  type UploadDeps,
  type UploadSource,
} from "../lib/e2e/upload-flow";
import {
  listPendingUploads,
  discardPendingUpload,
  type ResumeRecord,
  type ResumeStore,
} from "../lib/e2e/upload-resume";
import { openKeys, decryptShare } from "../lib/e2e/v2/share";
import { cryptoWorker } from "./crypto-worker";

function bytes(n: number, seed = 0): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n).map((_, i) => (i * 3 + seed) % 251);
}

async function read(source: UploadSource, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await new Blob([(await source.slice(start, end)) as BlobPart]).arrayBuffer());
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

function memoryStore(): ResumeStore & { records: Map<string, ResumeRecord> } {
  const records = new Map<string, ResumeRecord>();
  return {
    records,
    get: async (id) => records.get(id),
    put: async (rec) => void records.set(rec.id, rec),
    delete: async (id) => void records.delete(id),
    all: async () => [...records.values()],
  };
}

/**
 * A tus server stand-in. With breakAfter set, the first upload keeps that
 * many bytes and fails, the way a closed tab leaves it.
 */
function flakyServer(store: ResumeStore, breakAfter?: number) {
  const uploads = new Map<string, Uint8Array>();
  const calls: { resumeUrl?: string; from: number }[] = [];
  let full: Uint8Array | null = null;
  let finalized: FinalizeRequest | null = null;
  let n = 0;
  const deps: UploadDeps = {
    baseUrl: "https://drop.example.tld",
    crypto: cryptoWorker(),
    resume: store,
    async upload(source, { resumeUrl, onUploadUrl }) {
      let url = resumeUrl;
      if (!url) {
        url = `https://drop.example.tld/files/u${++n}`;
        uploads.set(url, new Uint8Array(0));
        await onUploadUrl?.(url);
      }
      const have = uploads.get(url)!;
      calls.push({ resumeUrl, from: have.length });
      const rest = await read(source, have.length, source.size);
      if (breakAfter !== undefined) {
        full = concat(have, rest);
        uploads.set(url, concat(have, rest.subarray(0, breakAfter)));
        breakAfter = undefined;
        throw new Error("network down");
      }
      uploads.set(url, concat(have, rest));
      return url.split("/").pop()!;
    },
    async finalize(body) {
      finalized = body;
      return { slug: "abc123" };
    },
  };
  return {
    deps,
    calls,
    stored: (id = "u1") => uploads.get(`https://drop.example.tld/files/${id}`)!,
    get full() {
      return full;
    },
    get finalized() {
      return finalized;
    },
  };
}

async function decrypt(blob: Uint8Array, shareUrl: string, password?: string) {
  const keys = await openKeys(new URL(shareUrl).hash.slice(3), password);
  const { header, plaintext } = await decryptShare(
    (async function* () {
      yield blob;
    })(),
    keys,
  );
  const parts: Uint8Array[] = [];
  for await (const p of plaintext) parts.push(p);
  return { header, plain: concat(...parts) };
}

const OPTS = { expiry: "1d", maxDownloads: null, format: 4 as const };
// Mid-file and not on a chunk boundary.
const BREAK = 150_000 + 123;

function film(seed = 0, lastModified = 1_700_000_000_000): File {
  return new File([bytes(300_000, seed)], "film.mp4", { type: "video/mp4", lastModified });
}

test("an upload that breaks off is listed by its files", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);

  const pending = await listPendingUploads(store);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].files, [{ name: "film.mp4", size: 300_000 }]);
});

test("a resumed upload sends exactly the bytes the broken one had left, from the server's offset", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);

  const { shareUrl } = await resumeUpload(id, [film()], server.deps);

  assert.deepEqual(server.calls.at(-1), { resumeUrl: "https://drop.example.tld/files/u1", from: BREAK });
  assert.deepEqual(server.stored(), server.full);
  assert.equal(server.finalized?.format, 4);
  const { plain } = await decrypt(server.stored(), shareUrl);
  assert.deepEqual(plain, bytes(300_000));
});

test("a bundle resumes when its files are picked again in another order", async () => {
  const store = memoryStore();
  const server = flakyServer(store, 7000);
  const a = new File([bytes(5000, 1)], "a.txt", { lastModified: 1 });
  const b = new File([bytes(9000, 2)], "b.bin", { lastModified: 2 });
  await assert.rejects(uploadEncrypted([a, b], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);

  const { shareUrl } = await resumeUpload(id, [b, a], server.deps);

  const { header, plain } = await decrypt(server.stored(), shareUrl);
  assert.deepEqual(
    header.files.map((f) => f.name),
    ["a.txt", "b.bin"],
  );
  assert.deepEqual(plain, concat(bytes(5000, 1), bytes(9000, 2)));
});

test("a link-and-password upload resumes without being given the password again", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(
    uploadEncrypted([film()], { ...OPTS, password: "correct horse battery" }, server.deps),
    /network down/,
  );
  const [{ id }] = await listPendingUploads(store);

  const { shareUrl } = await resumeUpload(id, [film()], server.deps);

  const { plain } = await decrypt(server.stored(), shareUrl, "correct horse battery");
  assert.deepEqual(plain, bytes(300_000));
});

test("resuming with a different file of the same name, size and date is refused", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);
  const calls = server.calls.length;

  await assert.rejects(resumeUpload(id, [film(7)], server.deps), /not the files of this upload/);

  assert.equal(server.calls.length, calls);
  assert.equal((await listPendingUploads(store)).length, 1);
});

test("resuming with a file that was saved again since is refused", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);

  await assert.rejects(resumeUpload(id, [film(0, 1_800_000_000_000)], server.deps), /not the files of this upload/);
});

test("resuming with a missing file is refused", async () => {
  const store = memoryStore();
  const server = flakyServer(store, 7000);
  const a = new File([bytes(5000, 1)], "a.txt", { lastModified: 1 });
  const b = new File([bytes(9000, 2)], "b.bin", { lastModified: 2 });
  await assert.rejects(uploadEncrypted([a, b], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);

  await assert.rejects(resumeUpload(id, [a], server.deps), /not the files of this upload/);
});

test("a finished upload leaves no record behind", async () => {
  const store = memoryStore();
  const server = flakyServer(store);
  await uploadEncrypted([film()], OPTS, server.deps);
  assert.equal(store.records.size, 0);
});

test("a resumed upload removes its record once it is finalized", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);

  await resumeUpload(id, [film()], server.deps);

  assert.equal(store.records.size, 0);
});

test("discarding a pending upload removes its record", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);

  await discardPendingUpload(store, id);

  assert.deepEqual(await listPendingUploads(store), []);
});

test("a record untouched for a day is dropped", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);

  assert.deepEqual(await listPendingUploads(store, Date.now() + 25 * 3600_000), []);
  assert.equal(store.records.size, 0);
});

test("the stored record keeps the key, the link and the file names sealed", async () => {
  const store = memoryStore();
  const server = flakyServer(store, BREAK);
  let shareToken = "";
  await assert.rejects(uploadEncrypted([film()], OPTS, server.deps), /network down/);
  const [{ id }] = await listPendingUploads(store);
  const rec = store.records.get(id)!;
  ({ shareUrl: shareToken } = await resumeUpload(id, [film()], server.deps));
  shareToken = new URL(shareToken).hash.slice(3);

  assert.equal(rec.key.extractable, false);
  const visible = Buffer.from(rec.sealed).toString("latin1") + JSON.stringify({ ...rec, key: null, sealed: null });
  for (const secret of [shareToken, "film.mp4", "video/mp4"]) {
    assert.ok(!visible.includes(secret), `${secret} is readable in the record`);
  }
});

test("an upload without a resume store keeps nothing and still works", async () => {
  const server = flakyServer(memoryStore());
  const deps = { ...server.deps, resume: undefined };
  const { shareUrl } = await uploadEncrypted([film()], OPTS, deps);
  const { plain } = await decrypt(server.stored(), shareUrl);
  assert.deepEqual(plain, bytes(300_000));
});

test("without crypto.subtle, as on plain HTTP, an upload keeps no record and still works", async () => {
  const store = memoryStore();
  const server = flakyServer(store);
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  try {
    const { shareUrl } = await uploadEncrypted([film()], OPTS, server.deps);
    assert.equal(store.records.size, 0);
    const { plain } = await decrypt(server.stored(), shareUrl);
    assert.deepEqual(plain, bytes(300_000));
  } finally {
    delete (globalThis.crypto as { subtle?: unknown }).subtle;
  }
  assert.ok(globalThis.crypto.subtle, "the stub is gone again");
});
