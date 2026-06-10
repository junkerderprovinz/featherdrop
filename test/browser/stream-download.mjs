// Browser test for the service-worker streaming download (Phase 3).
// esbuild-bundles lib/e2e/stream-download.ts → IIFE global StreamDownload,
// serves it from localhost so the SW can register (needs a secure/localhost origin),
// and asserts the downloaded bytes match the known pattern.
// Exit 0 = pass, 1 = fail.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// ── esbuild the client library ───────────────────────────────────────────────
const bundleResult = await build({
  entryPoints: [join(repoRoot, "lib/e2e/stream-download.ts")],
  bundle: true,
  format: "iife",
  globalName: "StreamDownload",
  platform: "browser",
  write: false,
});
const clientBundle = bundleResult.outputFiles[0].text;

// ── Read the service-worker source ──────────────────────────────────────────
const swSource = readFileSync(join(repoRoot, "public/sw-download.js"), "utf8");

// ── HTML served at / ────────────────────────────────────────────────────────
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>stream-download browser test</body>
</html>`;

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.url === "/sw-download.js") {
    // The SW must be served with Service-Worker-Allowed so it can claim scope /.
    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Service-Worker-Allowed": "/",
    });
    res.end(swSource);
    return;
  }
  // All other requests (the iframe /sw-download/<id> and the root page) get the
  // HTML so the SW can handle the fetch. In Playwright's download interception
  // the SW response (application/octet-stream) is what we'll actually capture.
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
console.log(`Test server listening at ${origin}`);

// ── Playwright ───────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const pageErrors = [];
const consoleMsgs = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

// Navigate to the page (needed for the SW to register on this origin).
await page.goto(`${origin}/`);

// Inject the bundled client library.
await page.addScriptTag({ content: clientBundle });

// ── Test constants ───────────────────────────────────────────────────────────
const CHUNK = 64 * 1024; // 64 KiB
const FRAMES = 32;        // 2 MiB total
const TOTAL = CHUNK * FRAMES;

// ── Trigger the download + capture it ────────────────────────────────────────
// We must race waitForEvent("download") with the evaluate that triggers it.
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 30_000 }),
  page.evaluate(
    ({ chunkSize, frames, total }) => {
      // Build a ReadableStream that emits `frames` chunks of `chunkSize` bytes
      // each filled with the pattern (i + j) % 251.
      let frameIdx = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (frameIdx >= frames) {
            controller.close();
            return;
          }
          const c = new Uint8Array(chunkSize);
          const i = frameIdx++;
          for (let j = 0; j < chunkSize; j++) c[j] = (i + j) % 251;
          controller.enqueue(c);
        },
      });

      // streamToDownload returns a Promise — awaiting it here ensures the SW is
      // ready and the postMessage was sent before the iframe navigation fires.
      return globalThis.StreamDownload.streamToDownload(stream, "secret.bin", total);
    },
    { chunkSize: CHUNK, frames: FRAMES, total: TOTAL },
  ),
]);

// ── Validate ──────────────────────────────────────────────────────────────────
const suggestedFilename = download.suggestedFilename();
const tmpPath = await download.path();

let pass = true;
const failures = [];

if (suggestedFilename !== "secret.bin") {
  failures.push(`filename: expected "secret.bin", got "${suggestedFilename}"`);
  pass = false;
}

if (!tmpPath) {
  failures.push("download path is null — download did not complete");
  pass = false;
} else {
  // Read back and verify every byte matches the known pattern.
  const bytes = readFileSync(tmpPath);
  if (bytes.length !== TOTAL) {
    failures.push(`size: expected ${TOTAL}, got ${bytes.length}`);
    pass = false;
  } else {
    let byteOk = true;
    outer: for (let i = 0; i < FRAMES; i++) {
      for (let j = 0; j < CHUNK; j++) {
        const expected = (i + j) % 251;
        if (bytes[i * CHUNK + j] !== expected) {
          failures.push(
            `byte mismatch at frame ${i} offset ${j}: expected ${expected}, got ${bytes[i * CHUNK + j]}`,
          );
          byteOk = false;
          break outer;
        }
      }
    }
    if (!byteOk) pass = false;
  }
}

if (pageErrors.length > 0) {
  failures.push(`pageErrors: ${pageErrors.join("; ")}`);
  pass = false;
}

// Cache the downloaded byte-count before closing the browser (which deletes the
// Playwright temp artifact directory).
const downloadedSize = tmpPath ? readFileSync(tmpPath).length : "N/A";

// ── Cleanup ───────────────────────────────────────────────────────────────────
await browser.close();
server.close();

// ── Report ────────────────────────────────────────────────────────────────────
console.log("stream-download:", {
  filename: suggestedFilename,
  size: downloadedSize,
  pageErrors,
  consoleMsgs,
});

if (!pass) {
  console.error("BROWSER TEST FAILED:", failures);
  process.exit(1);
}
console.log("BROWSER TESTS PASSED");
