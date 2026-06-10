// Browser test harness for the OPFS modules (run: `npm run test:browser`).
// esbuild-bundles a module to an IIFE, serves it from a localhost origin (OPFS
// needs a secure context — not about:blank), drives real Chromium via Playwright,
// and runs assertions inside the page. Kept out of `npm test` because it needs a
// browser. Exit code 0 = pass, 1 = fail.
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

async function bundle(entry, globalName) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName,
    platform: "browser",
    write: false,
  });
  return out.outputFiles[0].text;
}

async function serveLocalhost() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><body>browser test</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

const opfsScratch = await bundle("lib/e2e/opfs-scratch.ts", "OPFSScratch");
const { server, port } = await serveLocalhost();

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.addScriptTag({ content: opfsScratch });

const result = await page.evaluate(async () => {
  const { writeScratch, sweepStaleScratch } = globalThis.OPFSScratch;
  const CHUNK = 64 * 1024;
  const FRAMES = 32; // 2 MiB
  async function* gen() {
    for (let i = 0; i < FRAMES; i++) {
      const c = new Uint8Array(CHUNK);
      for (let j = 0; j < CHUNK; j++) c[j] = (i + j) % 251;
      yield c;
    }
  }

  // writeScratch: size + slice read-back
  const { file, cleanup } = await writeScratch(gen());
  const sizeOk = file.size === CHUNK * FRAMES;
  const buf = new Uint8Array(await file.slice(CHUNK, CHUNK * 2).arrayBuffer());
  let sliceOk = buf.length === CHUNK;
  for (let j = 0; j < CHUNK && sliceOk; j++) {
    if (buf[j] !== (1 + j) % 251) sliceOk = false;
  }

  // cleanup removes it
  await cleanup();
  const root = await navigator.storage.getDirectory();
  const countScratch = async () => {
    let n = 0;
    for await (const [name] of root.entries()) {
      if (name.startsWith("fd-scratch-")) n++;
    }
    return n;
  };
  const cleanupOk = (await countScratch()) === 0;

  // sweepStaleScratch removes an old planted file
  const old = await root.getFileHandle("fd-scratch-1000-deadbeef.bin", { create: true });
  const w = await old.createWritable();
  await w.write(new Uint8Array(10));
  await w.close();
  await sweepStaleScratch(0);
  const sweepOk = (await countScratch()) === 0;

  return { sizeOk, sliceOk, cleanupOk, sweepOk };
});

await browser.close();
server.close();

const pass =
  result.sizeOk &&
  result.sliceOk &&
  result.cleanupOk &&
  result.sweepOk &&
  pageErrors.length === 0;

console.log("opfs-scratch:", JSON.stringify(result), "pageErrors:", pageErrors);
if (!pass) {
  console.error("BROWSER TEST FAILED");
  process.exit(1);
}
console.log("BROWSER TESTS PASSED");
