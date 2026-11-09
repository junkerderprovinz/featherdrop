// Browser test for the tus adapter: lib/e2e/tus-upload.ts uploads a source
// that makes its bytes on demand to a small tus server in this process, over
// the browser's real XHR stack.
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const pageBundle = (
  await build({
    stdin: {
      contents: `
        import { tusUpload } from "./lib/e2e/tus-upload.ts";
        globalThis.__T = { tusUpload };
      `,
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  })
).outputFiles[0].text;

// Just enough of the tus protocol for the client: creation, HEAD and PATCH.
const uploads = new Map();
const patches = [];
let next = 0;
const server = createServer((req, res) => {
  const body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    if (req.url === "/page.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(pageBundle);
      return;
    }
    if (!req.url.startsWith("/files")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>tus test</body></html>`);
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
    if (req.method === "HEAD") {
      res.writeHead(200, { "Upload-Offset": String(up.data.length), "Upload-Length": String(up.length) }).end();
      return;
    }
    const offset = Number(req.headers["upload-offset"]);
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

await browser.close();
server.close();

if (pageErrors.length) failures.push("page errors: " + pageErrors.join("; "));
if (failures.length) {
  console.error("TUS UPLOAD BROWSER TEST FAILED\n" + failures.join("\n"));
  process.exit(1);
}
console.log("TUS UPLOAD BROWSER TESTS PASSED");
