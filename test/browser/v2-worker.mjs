// Browser test for the v2 crypto worker: lib/e2e/v2/worker.ts runs as a real
// module Web Worker in Chromium, and the page encrypts, decrypts and seeks
// through the message protocol.
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ESM rather than IIFE, because libsodium uses top-level await.
async function bundle(contents) {
  const out = await build({
    stdin: { contents, resolveDir: repoRoot, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  return out.outputFiles[0].text;
}

const workerBundle = await bundle(`import "./lib/e2e/v2/worker.ts";`);
const pageBundle = await bundle(`
import { connect } from "./lib/e2e/v2/protocol.ts";
import { cipherRange } from "./lib/e2e/v2/share.ts";
globalThis.__V2 = { connect, cipherRange };
`);

const server = createServer((req, res) => {
  const js = { "/worker.mjs": workerBundle, "/page.mjs": pageBundle }[req.url];
  if (js) {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(js);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>v2 worker test</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.addScriptTag({ url: "/page.mjs", type: "module" });
await page.waitForFunction(() => typeof globalThis.__V2 !== "undefined", { timeout: 30_000 });

const result = await page.evaluate(async () => {
  const { connect, cipherRange } = globalThis.__V2;
  const worker = () => connect(new Worker("/worker.mjs", { type: "module" }));
  const pattern = (n, seed) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) % 251;
    return b;
  };
  const join = (parts) => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  async function encrypt(files, data, password) {
    const w = worker();
    const open = await w.request({ op: "encrypt-open", session: 1, files, password });
    const parts = [open.prefix];
    for (let i = 0; i < data.length; i += 1 << 20) {
      const slice = data.slice(i, i + (1 << 20));
      parts.push(...(await w.request({ op: "encrypt-write", session: 1, data: slice }, [slice.buffer])).chunks);
    }
    for (;;) {
      const r = await w.request({ op: "encrypt-close", session: 1 });
      parts.push(...r.chunks);
      if (r.done) break;
    }
    const blob = join(parts);
    return { blob, token: open.token, verifier: open.verifier, lengthOk: blob.length === open.blobLength };
  }

  // A fresh worker, so the keys come from the token and password alone.
  async function decrypt(blob, token, password) {
    const w = worker();
    const { verifier } = await w.request({ op: "decrypt-open", session: 2, token, password });
    const out = [];
    let header = null;
    for (let i = 0; i < blob.length; i += 300_000) {
      const r = await w.request({ op: "decrypt-write", session: 2, data: blob.slice(i, i + 300_000) });
      header = header ?? r.header;
      out.push(...r.chunks);
    }
    await w.request({ op: "decrypt-close", session: 2 });
    return { verifier, header, plain: join(out) };
  }

  const checks = {};

  const big = pattern(3 * 1024 * 1024 + 11, 1);
  const single = await encrypt([{ name: "film.mp4", type: "video/mp4", size: big.length }], big, "correct horse battery");
  const back = await decrypt(single.blob, single.token, "correct horse battery");
  checks.singleLength = single.lengthOk;
  checks.singleVerifier = back.verifier === single.verifier;
  checks.singleRoundTrip = same(back.plain, big) && back.header.kind === "single";

  try {
    await decrypt(single.blob, single.token, "wrong horse battery");
    checks.wrongPassword = false;
  } catch (e) {
    checks.wrongPassword = /header/.test(String(e));
  }

  const a = pattern(10, 2);
  const b = pattern(200_000, 3);
  const files = [
    { name: "a.txt", type: "text/plain", size: a.length },
    { name: "b.bin", type: "", size: b.length },
  ];
  const bundle = await encrypt(files, join([a, b]));
  const bundleBack = await decrypt(bundle.blob, bundle.token);
  checks.bundleRoundTrip = same(bundleBack.plain, join([a, b])) && bundleBack.header.kind === "bundle";

  const w = worker();
  await w.request({ op: "decrypt-open", session: 3, token: single.token, password: "correct horse battery" });
  const headerLen = 5 + new DataView(single.blob.buffer).getUint32(1);
  const { header, contentOffset } = await w.request({
    op: "read-header",
    session: 3,
    data: single.blob.slice(0, headerLen),
  });
  const start = 2_000_000;
  const end = 2_100_000;
  const plan = cipherRange(header, contentOffset, start, end);
  const r = await w.request({
    op: "range",
    session: 3,
    header,
    contentOffset,
    start,
    end,
    data: single.blob.slice(plan.from, plan.to + 1),
  });
  checks.seek = same(join(r.chunks), big.subarray(start, end + 1));
  return checks;
});

await browser.close();
server.close();

const failed = Object.entries(result).filter(([, ok]) => ok !== true);
for (const [name, ok] of Object.entries(result)) console.log(`${ok === true ? "ok  " : "FAIL"} ${name}`);
if (pageErrors.length) console.log("page errors:", pageErrors);
if (failed.length || pageErrors.length) process.exit(1);
console.log("v2 worker browser test passed");
