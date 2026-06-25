// End-to-end test against the REALLY running app (built + started in CI).
// Verifies the whole zero-knowledge round trip through the browser + server:
// pick a file -> client encrypts (OPFS) -> tus upload -> finalize -> share link
// -> open link -> client fetches ciphertext -> decrypts -> downloads -> bytes match.
import { chromium } from "playwright";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "fd-e2e-"));
const SRC = join(tmp, "e2e-secret.bin");
const payload = randomBytes(3 * 1024 * 1024); // 3 MiB
writeFileSync(SRC, payload);

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("page: " + e));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

function fail(msg) {
  console.error("E2E FAILED:", msg, "| pageErrors:", errors);
  process.exit(1);
}

try {
  // ---- upload ----
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.setInputFiles('input[type="file"]', SRC);
  await page.getByRole("button", { name: /upload & share|hochladen & teilen/i }).click();

  // Wait for the result panel's share-URL field (the readonly input whose value
  // is the /d/ link) — NOT the expiry Select's readonly input.
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("input[readonly]")].some((i) =>
          i.value.includes("/d/"),
        ),
      { timeout: 120_000 },
    );
  } catch {
    const notes = await page
      .locator("[class*=Notification], [role=alert]")
      .allInnerTexts()
      .catch(() => []);
    fail("no share link appeared. notifications=" + JSON.stringify(notes));
  }
  const shareUrl = (
    await page.evaluate(
      () =>
        [...document.querySelectorAll("input[readonly]")].find((i) =>
          i.value.includes("/d/"),
        )?.value ?? "",
    )
  ).trim();
  console.log("share url:", shareUrl);
  if (!shareUrl.includes("/d/")) fail("share url missing /d/: " + shareUrl);
  if (!shareUrl.includes("#k=")) fail("link-mode share url missing #k= fragment");

  // ---- download (fresh page) ----
  const dlPage = await ctx.newPage();
  dlPage.on("pageerror", (e) => errors.push("dl page: " + e));
  dlPage.on("console", (m) => {
    if (m.type() === "error") errors.push("dl console: " + m.text());
  });
  await dlPage.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  const [download] = await Promise.all([
    dlPage.waitForEvent("download", { timeout: 120_000 }),
    dlPage.getByRole("button", { name: /download|herunterladen/i }).click(),
  ]);
  const gotPath = await download.path();
  const got = readFileSync(gotPath);

  const nameOk = download.suggestedFilename() === "e2e-secret.bin";
  const bytesOk = got.length === payload.length && got.equals(payload);
  console.log("downloaded:", {
    filename: download.suggestedFilename(),
    size: got.length,
    bytesMatch: bytesOk,
  });

  if (!nameOk) fail("filename mismatch: " + download.suggestedFilename());
  if (!bytesOk) fail("decrypted bytes do not match the original");
  if (errors.length) fail("page/console errors occurred");

  // ---- Phase 6: client-side preview of a v2 image ----
  // Upload a (valid, tiny) PNG; the download page must auto-decrypt it and
  // render an inline preview from an in-memory blob: URL (no server ?inline).
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const upPng = await ctx.newPage();
  upPng.on("pageerror", (e) => errors.push("png up: " + e));
  upPng.on("console", (m) => {
    if (m.type() === "error") errors.push("png up console: " + m.text());
  });
  await upPng.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await upPng.setInputFiles('input[type="file"]', {
    name: "preview.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await upPng
    .getByRole("button", { name: /upload & share|hochladen & teilen/i })
    .click();
  await upPng.waitForFunction(
    () =>
      [...document.querySelectorAll("input[readonly]")].some((i) =>
        i.value.includes("/d/"),
      ),
    { timeout: 120_000 },
  );
  const pngUrl = (
    await upPng.evaluate(
      () =>
        [...document.querySelectorAll("input[readonly]")].find((i) =>
          i.value.includes("/d/"),
        )?.value ?? "",
    )
  ).trim();

  const previewPage = await ctx.newPage();
  previewPage.on("pageerror", (e) => errors.push("preview: " + e));
  previewPage.on("console", (m) => {
    if (m.type() === "error") errors.push("preview console: " + m.text());
  });
  await previewPage.goto(pngUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await previewPage.waitForSelector('img[src^="blob:"]', { timeout: 120_000 });
  console.log("preview: blob image rendered ✓");
  if (errors.length) fail("page/console errors occurred (preview)");

  // ---- Phase 7: MULTI-FILE (format 3) round trip ----
  // Select 3 distinct files at once (link mode, no password); the app packs them
  // into ONE encrypted blob and finalizes format=3. The share page must list all
  // 3 files and "Download all" must save each one byte-identical to its original.
  await multiFileRoundTrip(ctx, errors, fail);

  console.log("E2E PASSED — zero-knowledge upload→download round trip verified");
} catch (e) {
  fail(String(e));
} finally {
  await browser.close();
}

// ───────────────────────────────────────────────────────────────────────────
// Multi-file (format 3) scenario — runs ALONGSIDE the single-file flow above,
// reusing the same browser context, error sink and fail()/exit-code contract.
// ───────────────────────────────────────────────────────────────────────────
async function multiFileRoundTrip(ctx, errors, fail) {
  // 3 distinct files of varied sizes with known random bytes:
  //  - one larger than 64 KiB so it spans secretstream chunk boundaries,
  //  - one tiny file,
  //  - one mid-sized file. Each gets its own random payload + filename.
  const files = [
    { name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(200 * 1024) }, // > 64 KiB
    { name: "tiny.txt", mimeType: "text/plain", buffer: randomBytes(7) }, // tiny
    { name: "middle.dat", mimeType: "application/octet-stream", buffer: randomBytes(40 * 1024) },
  ];
  const byName = new Map(files.map((f) => [f.name, f.buffer]));

  // ---- upload all 3 at once ----
  const up = await ctx.newPage();
  up.on("pageerror", (e) => errors.push("multi up: " + e));
  up.on("console", (m) => {
    if (m.type() === "error") errors.push("multi up console: " + m.text());
  });
  await up.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  // setInputFiles with an array sets all 3 on the dropzone's <input multiple>.
  await up.setInputFiles(
    'input[type="file"]',
    files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })),
  );
  await up
    .getByRole("button", { name: /upload & share|hochladen & teilen/i })
    .click();

  try {
    await up.waitForFunction(
      () =>
        [...document.querySelectorAll("input[readonly]")].some((i) =>
          i.value.includes("/d/"),
        ),
      { timeout: 120_000 },
    );
  } catch {
    const notes = await up
      .locator("[class*=Notification], [role=alert]")
      .allInnerTexts()
      .catch(() => []);
    fail("multi: no share link appeared. notifications=" + JSON.stringify(notes));
  }
  const shareUrl = (
    await up.evaluate(
      () =>
        [...document.querySelectorAll("input[readonly]")].find((i) =>
          i.value.includes("/d/"),
        )?.value ?? "",
    )
  ).trim();
  console.log("multi share url:", shareUrl);
  if (!shareUrl.includes("/d/")) fail("multi: share url missing /d/: " + shareUrl);
  if (!shareUrl.includes("#k=")) fail("multi: link-mode share url missing #k=");

  // ---- open the share link in a fresh page ----
  const dl = await ctx.newPage();
  dl.on("pageerror", (e) => errors.push("multi dl: " + e));
  dl.on("console", (m) => {
    if (m.type() === "error") errors.push("multi dl console: " + m.text());
  });

  // Capture EVERY download the page fires. "Download all" saves the 3 files
  // sequentially, so we collect them as they arrive (order is manifest order).
  const downloads = [];
  dl.on("download", (d) => downloads.push(d));

  await dl.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // The file list (manifest) must show all 3 entries. For a password-less,
  // in-cap link share the manifest auto-reveals on mount, so each original
  // filename appears in the DOM. Wait until all 3 names are present.
  for (const f of files) {
    await dl.getByText(f.name, { exact: true }).waitFor({ timeout: 120_000 });
  }
  console.log("multi: file list shows all 3 entries ✓");

  // Trigger "Download all" — it saves the 3 files sequentially, each firing a
  // separate "download" event captured above.
  await dl
    .getByRole("button", { name: /download all|alle herunterladen/i })
    .click();
  // Poll until 3 downloads have been observed (or time out loudly).
  const deadline = Date.now() + 120_000;
  while (downloads.length < 3 && Date.now() < deadline) {
    await dl.waitForTimeout(100);
  }
  if (downloads.length !== 3) {
    fail("multi: expected 3 downloads, got " + downloads.length);
  }

  // ---- assert each downloaded file is byte-identical to its original ----
  const seen = new Set();
  for (const d of downloads) {
    const fname = d.suggestedFilename();
    seen.add(fname);
    const expected = byName.get(fname);
    if (!expected) fail("multi: unexpected downloaded filename: " + fname);
    const got = readFileSync(await d.path());
    const ok = got.length === expected.length && got.equals(expected);
    console.log("multi downloaded:", {
      filename: fname,
      size: got.length,
      bytesMatch: ok,
    });
    if (!ok) fail("multi: bytes for " + fname + " do not match the original");
  }
  if (seen.size !== 3) fail("multi: filenames not all distinct: " + [...seen]);
  for (const f of files) {
    if (!seen.has(f.name)) fail("multi: missing downloaded file " + f.name);
  }
  if (errors.length) fail("page/console errors occurred (multi-file)");
  console.log("multi-file: 3-file Download-all round trip verified ✓");
}
