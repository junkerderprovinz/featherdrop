// Browser test for the service worker streaming download. The page is served
// from localhost so the worker can register, and the saved bytes are checked
// against a known pattern.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const bundleResult = await build({
  entryPoints: [join(repoRoot, "lib/e2e/stream-download.ts")],
  bundle: true,
  format: "iife",
  globalName: "StreamDownload",
  platform: "browser",
  write: false,
});
const clientBundle = bundleResult.outputFiles[0].text;

const swSource = readFileSync(join(repoRoot, "public/sw-download.js"), "utf8");

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>stream-download browser test</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === "/sw-download.js") {
    // Service-Worker-Allowed lets the worker claim the scope /.
    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Service-Worker-Allowed": "/",
    });
    res.end(swSource);
    return;
  }
  // Everything else gets the page; the worker answers the iframe's
  // /sw-download/<id> fetch itself.
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
console.log(`Test server listening at ${origin}`);

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const pageErrors = [];
const consoleMsgs = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

await page.goto(`${origin}/`);

await page.addScriptTag({ content: clientBundle });

const CHUNK = 64 * 1024;
const FRAMES = 32;
const TOTAL = CHUNK * FRAMES;

const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 30_000 }),
  page.evaluate(
    ({ chunkSize, frames, total }) => {
      // Each frame holds the pattern (i + j) % 251.
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

      // Awaiting it makes sure the worker got the stream before the iframe
      // navigates.
      return globalThis.StreamDownload.streamToDownload(stream, "secret.bin", total);
    },
    { chunkSize: CHUNK, frames: FRAMES, total: TOTAL },
  ),
]);

const suggestedFilename = download.suggestedFilename();
const tmpPath = await download.path();

let pass = true;
const failures = [];

if (suggestedFilename !== "secret.bin") {
  failures.push(`filename: expected "secret.bin", got "${suggestedFilename}"`);
  pass = false;
}

if (!tmpPath) {
  failures.push("download path is null, the download did not complete");
  pass = false;
} else {
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

// Closing the browser deletes Playwright's download directory.
const downloadedSize = tmpPath ? readFileSync(tmpPath).length : "N/A";

await browser.close();
server.close();

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
