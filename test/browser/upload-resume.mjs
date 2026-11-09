// Browser test for uploads that resume: lib/e2e/tus-upload.ts sends a source
// that makes its bytes on demand to a small tus server in this process, over
// the browser's real XHR stack, and a format 4 upload cut off by a reload goes
// on from its IndexedDB record once the same file is picked again.
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inlineWorker } from "../inline-worker.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const pageBundle = (
  await build({
    stdin: {
      contents: `
        import { tusUpload } from "./lib/e2e/tus-upload.ts";
        import { uploadEncrypted, resumeUpload } from "./lib/e2e/upload-flow.ts";
        import { listPendingUploads, indexedDbResumeStore } from "./lib/e2e/upload-resume.ts";
        import { openKeys, decryptShare } from "./lib/e2e/v2/share.ts";
        import { cryptoWorker } from "./lib/e2e/v2/crypto-worker.ts";
        globalThis.__T = {
          tusUpload, uploadEncrypted, resumeUpload, listPendingUploads, indexedDbResumeStore, openKeys, decryptShare, cryptoWorker,
        };
      `,
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [inlineWorker],
  })
).outputFiles[0].text;

// Just enough of the tus protocol for the client: creation, HEAD and PATCH.
const uploads = new Map();
const patches = [];
let next = 0;
// While set, PATCH requests after the first one of an upload get no answer.
let hang = false;
const server = createServer((req, res) => {
  const body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    if (req.url === "/page.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(pageBundle);
      return;
    }
    if (req.url.startsWith("/blob/")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(uploads.get(req.url.split("/").pop()).data);
      return;
    }
    if (!req.url.startsWith("/files")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>upload resume test</body></html>`);
      return;
    }
    res.setHeader("Tus-Resumable", "1.0.0");
    res.setHeader("Access-Control-Expose-Headers", "Location, Upload-Offset, Upload-Length");
    if (req.method === "POST") {
      const id = `u${++next}`;
      uploads.set(id, { length: Number(req.headers["upload-length"]), data: Buffer.alloc(0) });
      res.writeHead(201, { Location: `/files/${id}` }).end();
      return;
    }
    const id = req.url.split("/").pop();
    const up = uploads.get(id);
    if (!up) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "DELETE") {
      uploads.delete(id);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Upload-Offset": String(up.data.length), "Upload-Length": String(up.length) }).end();
      return;
    }
    const offset = Number(req.headers["upload-offset"]);
    if (hang && offset > 0) return;
    if (offset !== up.data.length) {
      res.writeHead(409).end();
      return;
    }
    const chunk = Buffer.concat(body);
    patches.push([id, offset, chunk.length]);
    up.data = Buffer.concat([up.data, chunk]);
    res.writeHead(204, { "Upload-Offset": String(up.data.length) }).end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`${base}/`);
await page.addScriptTag({ url: "/page.mjs", type: "module" });
await page.waitForFunction(() => globalThis.__T !== undefined);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok" : "FAILED"}: ${name}`);
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
}

const chunked = await page.evaluate(async () => {
  const data = new Uint8Array(2500).map((_, i) => (i * 13) % 251);
  const progress = [];
  const id = await globalThis.__T.tusUpload(
    { size: data.length, slice: async (s, e) => data.slice(s, e) },
    { chunkSize: 1000, onProgress: (sent) => progress.push(sent) },
  );
  return { id, last: progress.at(-1) };
});
const expected = Buffer.from(new Uint8Array(2500).map((_, i) => (i * 13) % 251));
check(
  "tusUpload sends the source in chunk-sized requests and resolves to the upload id",
  chunked.id === "u1" &&
    chunked.last === 2500 &&
    uploads.get("u1").data.equals(expected) &&
    JSON.stringify(patches) === JSON.stringify([["u1", 0, 1000], ["u1", 1000, 1000], ["u1", 2000, 500]]),
  { chunked, patches },
);

// The first attempt dies after its first request, the way a closed tab leaves
// an upload; the second picks it up by URL.
patches.length = 0;
const resumed = await page.evaluate(async () => {
  const data = new Uint8Array(2500).map((_, i) => (i * 7) % 251);
  const urls = [];
  let broken = true;
  const failing = {
    size: data.length,
    slice: async (s, e) => {
      if (s > 0 && broken) throw new Error("tab closed");
      return data.slice(s, e);
    },
  };
  const first = await globalThis.__T
    .tusUpload(failing, { chunkSize: 1000, onUploadUrl: (u) => urls.push(u) })
    .then(() => "finished", (e) => String(e));
  broken = false;
  const id = await globalThis.__T.tusUpload(failing, { chunkSize: 1000, resumeUrl: urls[0] });
  return { first, urls, id };
});
const want = Buffer.from(new Uint8Array(2500).map((_, i) => (i * 7) % 251));
check(
  "tusUpload reports a new upload's URL and resumes it from the server's offset",
  resumed.first.includes("tab closed") &&
    resumed.urls.length === 1 &&
    resumed.urls[0].endsWith("/files/u2") &&
    resumed.id === "u2" &&
    uploads.get("u2").data.equals(want) &&
    JSON.stringify(patches) === JSON.stringify([["u2", 0, 1000], ["u2", 1000, 1000], ["u2", 2000, 500]]),
  { resumed, patches },
);

// Cancelling stops the upload and tells the server to drop what it has.
hang = true;
const cancelled = await page.evaluate(async () => {
  const data = new Uint8Array(2500);
  const stop = new AbortController();
  const urls = [];
  const result = globalThis.__T
    .tusUpload(
      { size: data.length, slice: async (s, e) => data.slice(s, e) },
      { chunkSize: 1000, signal: stop.signal, onUploadUrl: (u) => urls.push(u), onProgress: (sent) => sent >= 1000 && stop.abort() },
    )
    .then(() => "finished", (e) => e.name);
  return { outcome: await result, id: urls[0]?.split("/").pop() };
});
check(
  "tusUpload stops when its signal aborts and deletes the upload on the server",
  cancelled.outcome === "AbortError" && cancelled.id && !uploads.has(cancelled.id),
  { cancelled, left: [...uploads.keys()] },
);
hang = false;

// A format 4 upload loses its tab after the first request. After the reload
// the page lists it from IndexedDB, the same file is picked again, and the
// upload goes on from the server's offset to a blob that decrypts.
hang = true;
patches.length = 0;
const start = page.evaluate(async () => {
  const { uploadEncrypted, tusUpload, indexedDbResumeStore, cryptoWorker } = globalThis.__T;
  const data = new Uint8Array(20_000).map((_, i) => (i * 11) % 251);
  const file = new File([data], "report.pdf", { type: "application/pdf", lastModified: 1_700_000_000_000 });
  await uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, {
    baseUrl: location.origin,
    crypto: cryptoWorker,
    resume: indexedDbResumeStore(),
    upload: (source, o) => tusUpload(source, { ...o, chunkSize: 8192 }),
    finalize: async () => ({ slug: "never" }),
  });
});
start.catch(() => {});
const deadline = Date.now() + 30_000;
while (patches.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
await page.reload();
hang = false;
await page.addScriptTag({ url: "/page.mjs", type: "module" });
await page.waitForFunction(() => globalThis.__T !== undefined);

const after = await page.evaluate(async () => {
  const { resumeUpload, listPendingUploads, indexedDbResumeStore, tusUpload, openKeys, decryptShare, cryptoWorker } = globalThis.__T;
  const store = indexedDbResumeStore();
  const pending = await listPendingUploads(store);
  const data = new Uint8Array(20_000).map((_, i) => (i * 11) % 251);
  const file = new File([data], "report.pdf", { type: "application/pdf", lastModified: 1_700_000_000_000 });
  const other = new File([data.map((b) => b ^ 1)], "report.pdf", { lastModified: 1_700_000_000_000 });
  let uploadId = "";
  const deps = {
    baseUrl: location.origin,
    crypto: cryptoWorker,
    resume: store,
    upload: async (source, o) => (uploadId = await tusUpload(source, { ...o, chunkSize: 8192 })),
    finalize: async () => ({ slug: "abc" }),
  };
  const refused = await resumeUpload(pending[0].id, [other], deps).then(() => "", (e) => String(e));
  const { shareUrl } = await resumeUpload(pending[0].id, [file], deps);

  const blob = new Uint8Array(await (await fetch(`/blob/${uploadId}`)).arrayBuffer());
  const keys = await openKeys(new URL(shareUrl).hash.slice(3));
  const { plaintext } = await decryptShare((async function* () { yield blob; })(), keys);
  const parts = [];
  for await (const p of plaintext) parts.push(...p);
  return {
    pending: pending.map((p) => p.files),
    refused,
    uploadId,
    same: parts.length === data.length && parts.every((b, i) => b === data[i]),
    left: (await listPendingUploads(store)).length,
  };
});
check(
  "a format 4 upload cut off by a reload resumes from IndexedDB with the same file",
  JSON.stringify(after.pending) === JSON.stringify([[{ name: "report.pdf", size: 20_000 }]]) &&
    after.refused.includes("not the files of this upload") &&
    after.same &&
    after.left === 0 &&
    patches[0][1] === 0 &&
    patches[1][0] === after.uploadId &&
    patches[1][1] === 8192,
  { after, patches },
);

await browser.close();
server.close();


if (pageErrors.length) failures.push("page errors: " + pageErrors.join("; "));
if (failures.length) {
  console.error("UPLOAD RESUME BROWSER TEST FAILED\n" + failures.join("\n"));
  process.exit(1);
}
console.log("UPLOAD RESUME BROWSER TESTS PASSED");
