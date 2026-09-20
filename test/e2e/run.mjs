// End-to-end test against the running app, built and started in CI: pick a
// file, encrypt, upload with tus, finalize, open the link, decrypt, download,
// compare the bytes.
import { chromium } from "playwright";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "fd-e2e-"));
const SRC = join(tmp, "e2e-secret.bin");
const payload = randomBytes(3 * 1024 * 1024);
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
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.setInputFiles('input[type="file"]', SRC);
  await page.getByRole("button", { name: /upload & share|hochladen & teilen/i }).click();

  // The expiry Select is readonly too, so the share field is the one holding a
  // /d/ link.
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

  // A tiny PNG must be decrypted on the download page and previewed from a
  // blob: URL.
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

  await multiFileRoundTrip(ctx, errors, fail);

  console.log("E2E PASSED: zero-knowledge upload→download round trip verified");
} catch (e) {
  fail(String(e));
} finally {
  await browser.close();
}

// Three files uploaded together become one format 3 share. The share page has
// to list all three, and "Download all" has to save each byte-identical.
async function multiFileRoundTrip(ctx, errors, fail) {
  // The first spans several chunks.
  const files = [
    { name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(200 * 1024) },
    { name: "tiny.txt", mimeType: "text/plain", buffer: randomBytes(7) },
    { name: "middle.dat", mimeType: "application/octet-stream", buffer: randomBytes(40 * 1024) },
  ];
  const byName = new Map(files.map((f) => [f.name, f.buffer]));

  const up = await ctx.newPage();
  up.on("pageerror", (e) => errors.push("multi up: " + e));
  up.on("console", (m) => {
    if (m.type() === "error") errors.push("multi up console: " + m.text());
  });
  await up.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
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

  const dl = await ctx.newPage();
  dl.on("pageerror", (e) => errors.push("multi dl: " + e));
  dl.on("console", (m) => {
    if (m.type() === "error") errors.push("multi dl console: " + m.text());
  });

  // "Download all" saves the files one after another in manifest order.
  const downloads = [];
  dl.on("download", (d) => downloads.push(d));

  await dl.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // A small link share without a password shows its file list on mount.
  for (const f of files) {
    await dl.getByText(f.name, { exact: true }).waitFor({ timeout: 120_000 });
  }
  console.log("multi: file list shows all 3 entries ✓");

  await dl
    .getByRole("button", { name: /download all|alle herunterladen/i })
    .click();
  const deadline = Date.now() + 120_000;
  while (downloads.length < 3 && Date.now() < deadline) {
    await dl.waitForTimeout(100);
  }
  if (downloads.length !== 3) {
    fail("multi: expected 3 downloads, got " + downloads.length);
  }

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
