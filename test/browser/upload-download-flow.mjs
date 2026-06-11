// Browser test for the upload-download orchestration modules.
// Bundles lib/e2e/upload-flow.ts + lib/e2e/download-flow.ts together as ESM,
// serves from localhost (OPFS + crypto need a secure context), and runs real
// encrypt→upload→download→decrypt round-trips in Chromium via Playwright.
// Exit 0 = pass, 1 = fail.
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// ── Bundle both flow modules as an ESM (required: libsodium uses top-level
//    await which is incompatible with the IIFE format). ─────────────────────
// We need the functions accessible from page.evaluate; the trick is to inject
// them as an ESM module and expose via globalThis inside the module body.
const entryCode = `
import { uploadEncrypted } from "./lib/e2e/upload-flow.ts";
import { downloadDecrypted } from "./lib/e2e/download-flow.ts";
globalThis.__FlowModules = { uploadEncrypted, downloadDecrypted };
`;

const bundleResult = await build({
  stdin: {
    contents: entryCode,
    resolveDir: repoRoot,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const clientBundle = bundleResult.outputFiles[0].text;

// ── Minimal HTTP server ──────────────────────────────────────────────────────
const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>flow test</body></html>`;
const server = createServer((req, res) => {
  if (req.url === "/bundle.mjs") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(clientBundle);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
console.log(`Test server at http://127.0.0.1:${port}/`);

// ── Playwright ───────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
const consoleMsgs = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

await page.goto(`http://127.0.0.1:${port}/`);

// Inject ESM bundle via <script type="module"> tag and wait for it to assign
// globalThis.__FlowModules before we run the page.evaluate below.
await page.addScriptTag({
  url: `/bundle.mjs`,
  type: "module",
});

// Wait until the module has finished initialising (libsodium WASM loads async).
await page.waitForFunction(() => typeof globalThis.__FlowModules !== "undefined", {
  timeout: 30_000,
});

// ── Run tests inside the page ─────────────────────────────────────────────────
const result = await page.evaluate(async () => {
  const { uploadEncrypted, downloadDecrypted } = globalThis.__FlowModules;

  // ── Pattern helpers ────────────────────────────────────────────────────────
  const CHUNK = 64 * 1024;
  const FRAMES = 32; // 2 MiB

  function makePattern(seed = 0) {
    const buf = new Uint8Array(CHUNK * FRAMES);
    for (let i = 0; i < CHUNK * FRAMES; i++) buf[i] = (seed + i) % 251;
    return buf;
  }

  function patternsEqual(a, b) {
    if (a.length !== b.length) return `length mismatch: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return `byte mismatch at ${i}: ${a[i]} vs ${b[i]}`;
    }
    return null;
  }

  /** Collect a ReadableStream into a Uint8Array. */
  async function collectStream(rs) {
    const reader = rs.getReader();
    const parts = [];
    let len = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      len += value.length;
    }
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // ── In-memory fake server store ────────────────────────────────────────────
  // upload() reads the File into memory; finalize() hands back a slug.
  // The download side reads directly from the store.
  const blobStore = new Map(); // uploadId -> Uint8Array
  const metaStore = new Map(); // slug -> finalizeBody

  let idCounter = 0;
  let slugCounter = 0;

  function makeDeps(baseUrl = "https://x") {
    return {
      baseUrl,
      async upload(file, onProgress) {
        const id = `upload-${++idCounter}`;
        const ab = await file.arrayBuffer();
        blobStore.set(id, new Uint8Array(ab));
        onProgress(ab.byteLength, ab.byteLength);
        return id;
      },
      async finalize(body) {
        const slug = `slug-${++slugCounter}`;
        metaStore.set(slug, body);
        return { slug };
      },
    };
  }

  function getBlobStream(uploadId) {
    const bytes = blobStore.get(uploadId);
    if (!bytes) throw new Error("No blob for " + uploadId);
    return new ReadableStream({
      start(controller) {
        // Serve in 64 KiB chunks to exercise the stream path.
        let offset = 0;
        function pump() {
          if (offset >= bytes.length) { controller.close(); return; }
          const end = Math.min(offset + 64 * 1024, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
          pump();
        }
        pump();
      },
    });
  }

  // ── Helper: base64 decode (atob → Uint8Array) ──────────────────────────────
  function b64decode(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const failures = [];

  // ========================================================================
  // Test 1: LINK MODE round-trip (2 MiB)
  // ========================================================================
  try {
    const original = makePattern(0);
    const file = new File([original], "My Photo.png", { type: "image/png" });
    const deps = makeDeps("https://x");

    const phases = [];
    const { shareUrl } = await uploadEncrypted(
      file,
      { expiry: "7d", maxDownloads: null },
      deps,
      (phase, frac) => phases.push({ phase, frac }),
    );

    // shareUrl must contain #k=
    const hashIdx = shareUrl.indexOf("#k=");
    if (hashIdx === -1) {
      failures.push("link mode: shareUrl missing #k= fragment: " + shareUrl);
    } else {
      const keyFromUrl = shareUrl.slice(hashIdx + 3);
      const slug = shareUrl.slice("https://x/d/".length, hashIdx);
      const body = metaStore.get(slug);

      // finalize body must carry the key verifier (43-char base64url).
      if (!/^[A-Za-z0-9_-]{43}$/.test(body.keyVerifier || "")) {
        failures.push("link mode: finalize body missing/invalid keyVerifier: " + body.keyVerifier);
      }

      let recoveredFilename;
      let recoveredBytes;
      let sentVerifier;
      const { meta } = await downloadDecrypted(
        (keyVerifier) => {
          sentVerifier = keyVerifier;
          return Promise.resolve(getBlobStream(body.uploadId));
        },
        { keyFromUrl },
        async (plaintext, filename) => {
          recoveredFilename = filename;
          recoveredBytes = await collectStream(plaintext);
        },
      );

      // The proof sent on download must equal what finalize stored — otherwise
      // the real server would 401 before counting the download.
      if (sentVerifier !== body.keyVerifier) {
        failures.push(`link mode: download verifier ${sentVerifier} != finalize keyVerifier ${body.keyVerifier}`);
      }

      if (recoveredFilename !== "My Photo.png") {
        failures.push(`link mode: filename expected "My Photo.png", got "${recoveredFilename}"`);
      }
      if (meta.name !== "My Photo.png") {
        failures.push(`link mode: meta.name expected "My Photo.png", got "${meta.name}"`);
      }
      if (meta.type !== "image/png") {
        failures.push(`link mode: meta.type expected "image/png", got "${meta.type}"`);
      }
      const mismatch = patternsEqual(original, recoveredBytes);
      if (mismatch) failures.push("link mode: byte mismatch: " + mismatch);

      // Phases sanity
      const hasEncrypt = phases.some((p) => p.phase === "encrypting");
      const hasUpload = phases.some((p) => p.phase === "uploading");
      if (!hasEncrypt) failures.push("link mode: no encrypting phase reported");
      if (!hasUpload) failures.push("link mode: no uploading phase reported");
    }
  } catch (err) {
    failures.push("link mode threw: " + String(err) + "\n" + (err && err.stack ? err.stack : ""));
  }

  // ========================================================================
  // Test 2: PASSWORD MODE round-trip (2 MiB)
  // ========================================================================
  let passwordSlug;
  let passwordUploadId;
  try {
    const original = makePattern(17);
    const file = new File([original], "Secret.zip", { type: "application/zip" });
    const deps = makeDeps("https://x");

    const { shareUrl } = await uploadEncrypted(
      file,
      { expiry: "1d", maxDownloads: 3, password: "pw" },
      deps,
    );

    // Password mode: NO #k= in the URL
    if (shareUrl.includes("#k=")) {
      failures.push("password mode: shareUrl must NOT contain #k=: " + shareUrl);
    }

    const slug = shareUrl.slice("https://x/d/".length);
    passwordSlug = slug;
    const body = metaStore.get(slug);
    passwordUploadId = body.uploadId;

    // finalize body must carry wrappedKey + kdfSalt + keyVerifier
    if (!body.wrappedKey) failures.push("password mode: finalize body missing wrappedKey");
    if (!body.kdfSalt) failures.push("password mode: finalize body missing kdfSalt");
    if (body.format !== 2) failures.push("password mode: format must be 2, got " + body.format);
    if (body.maxDownloads !== 3) failures.push("password mode: maxDownloads expected 3, got " + body.maxDownloads);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.keyVerifier || "")) {
      failures.push("password mode: finalize body missing/invalid keyVerifier: " + body.keyVerifier);
    }

    const wrapped = b64decode(body.wrappedKey);
    const salt = b64decode(body.kdfSalt);

    let recoveredFilename;
    let recoveredBytes;
    let sentVerifier;
    const { meta } = await downloadDecrypted(
      (keyVerifier) => {
        sentVerifier = keyVerifier;
        return Promise.resolve(getBlobStream(body.uploadId));
      },
      { password: "pw", wrapped, salt },
      async (plaintext, filename) => {
        recoveredFilename = filename;
        recoveredBytes = await collectStream(plaintext);
      },
    );

    if (sentVerifier !== body.keyVerifier) {
      failures.push(`password mode: download verifier ${sentVerifier} != finalize keyVerifier ${body.keyVerifier}`);
    }

    if (recoveredFilename !== "Secret.zip") {
      failures.push(`password mode: filename expected "Secret.zip", got "${recoveredFilename}"`);
    }
    if (meta.type !== "application/zip") {
      failures.push(`password mode: type expected "application/zip", got "${meta.type}"`);
    }
    const mismatch = patternsEqual(original, recoveredBytes);
    if (mismatch) failures.push("password mode: byte mismatch: " + mismatch);
  } catch (err) {
    failures.push("password mode threw: " + String(err) + "\n" + (err && err.stack ? err.stack : ""));
  }

  // ========================================================================
  // Test 3: WRONG PASSWORD rejects
  // ========================================================================
  try {
    if (passwordSlug && passwordUploadId) {
      const body = metaStore.get(passwordSlug);
      const wrapped = b64decode(body.wrappedKey);
      const salt = b64decode(body.kdfSalt);

      let rejected = false;
      try {
        await downloadDecrypted(
          () => Promise.resolve(getBlobStream(passwordUploadId)),
          { password: "wrong-password", wrapped, salt },
          async () => {},
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        failures.push("wrong password: expected rejection but it resolved");
      }
    } else {
      failures.push("wrong password test skipped: no password upload available");
    }
  } catch (err) {
    failures.push("wrong password check threw unexpectedly: " + String(err));
  }

  // ========================================================================
  // Test 4: maxDownloads: null preserved in finalize body
  // ========================================================================
  try {
    const file = new File([new Uint8Array(100)], "tiny.bin", { type: "application/octet-stream" });
    const deps = makeDeps();
    const { shareUrl } = await uploadEncrypted(file, { expiry: "7d", maxDownloads: null }, deps);
    const hashIdx = shareUrl.indexOf("#k=");
    const slug = shareUrl.slice("https://x/d/".length, hashIdx === -1 ? undefined : hashIdx);
    const body = metaStore.get(slug);
    if (body.maxDownloads !== null) {
      failures.push("maxDownloads null: expected null, got " + body.maxDownloads);
    }
  } catch (err) {
    failures.push("maxDownloads null test threw: " + String(err));
  }

  return { failures };
});

await browser.close();
server.close();

const pass = result.failures.length === 0 && pageErrors.length === 0;

console.log("upload-download-flow:", {
  failures: result.failures,
  pageErrors,
  consoleMsgs: consoleMsgs.filter((m) => !m.startsWith("[log]")).slice(0, 20),
});

if (!pass) {
  if (result.failures.length > 0) {
    console.error("TEST FAILURES:");
    for (const f of result.failures) console.error(" -", f);
  }
  if (pageErrors.length > 0) {
    console.error("PAGE ERRORS:", pageErrors);
  }
  console.error("BROWSER TEST FAILED");
  process.exit(1);
}
console.log("BROWSER TESTS PASSED");
