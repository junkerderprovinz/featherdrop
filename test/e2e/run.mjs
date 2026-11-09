// End-to-end test against the running app, built and started in CI: pick a
// file, encrypt, upload with tus, finalize, open the link, decrypt, download,
// compare the bytes. The run makes more share requests than one address may
// send per minute, so the server needs RATE_LIMIT=false.
import { chromium } from "playwright";
import { build } from "esbuild";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

  await revokeRoundTrip(ctx, page, shareUrl, errors, fail);

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
  await format4RoundTrips(browser, errors, fail);
  // Last, because the limit switch is remembered for later uploads.
  await limitedShareListsBeforeDownload(ctx, errors, fail);

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

function readonlyValue(page, part) {
  return page.evaluate(
    (p) =>
      [...document.querySelectorAll("input[readonly]")].find((i) =>
        i.value.includes(p),
      )?.value ?? "",
    part,
  );
}

// The result panel also shows the management link. Opening it and confirming
// the delete removes the share for good.
async function revokeRoundTrip(ctx, uploadPage, shareUrl, errors, fail) {
  const manageUrl = (await readonlyValue(uploadPage, "/m/")).trim();
  if (!manageUrl.includes("#t=")) fail("management link missing or without #t=: " + manageUrl);
  if (manageUrl.split("#t=")[1] === shareUrl.split("#k=")[1]) {
    fail("the management token must differ from the content key");
  }

  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("manage: " + e));
  await page.goto(manageUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("button", { name: /delete now|jetzt löschen/i }).click();
  await page
    .getByRole("button", { name: /click again to confirm|zum bestätigen erneut klicken/i })
    .click();
  await page
    .getByText(/share deleted|freigabe gelöscht/i)
    .waitFor({ timeout: 30_000 });

  const slug = new URL(shareUrl).pathname.split("/").pop();
  const meta = await page.request.get(`${BASE}/api/d/${slug}/meta`);
  if (meta.status() !== 404) fail("share still there after revoke: meta " + meta.status());
  if (errors.length) fail("page/console errors occurred (revoke)");
  console.log("revoke: management link deleted the share ✓");
}

// A once-only share shows its file name from the uncounted header and is
// still unspent afterwards.
async function limitedShareListsBeforeDownload(ctx, errors, fail) {
  const up = await ctx.newPage();
  up.on("pageerror", (e) => errors.push("limited up: " + e));
  await up.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await up.setInputFiles('input[type="file"]', {
    name: "once-only.bin",
    mimeType: "application/octet-stream",
    buffer: randomBytes(4096),
  });
  await up.getByRole("switch", { name: /limit downloads|download-limit/i }).check();
  await up.getByRole("button", { name: /upload & share|hochladen & teilen/i }).click();
  await up.waitForFunction(
    () => [...document.querySelectorAll("input[readonly]")].some((i) => i.value.includes("/d/")),
    { timeout: 120_000 },
  );
  const shareUrl = (await readonlyValue(up, "/d/")).trim();

  const dl = await ctx.newPage();
  dl.on("pageerror", (e) => errors.push("limited dl: " + e));
  await dl.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await dl.getByText("once-only.bin", { exact: true }).waitFor({ timeout: 120_000 });

  const slug = new URL(shareUrl).pathname.split("/").pop();
  const meta = await (await dl.request.get(`${BASE}/api/d/${slug}/meta`)).json();
  if (meta.downloadsLeft !== 1) fail("listing spent the share: downloadsLeft " + meta.downloadsLeft);
  if (errors.length) fail("page/console errors occurred (limited share)");
  console.log("limited share: name shown before the download, nothing spent ✓");
}

// The upload page does not write format 4 yet, so these shares go through the
// client library directly, bundled and loaded into a page of the app. The
// context skips the CSP, which would block the injected module.
async function format4RoundTrips(browser, errors, fail) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const bundle = await build({
    stdin: {
      contents: `
        import * as tus from "tus-js-client";
        import { uploadEncrypted } from "./lib/e2e/upload-flow.ts";
        import { downloadDecryptedV2, fetchShareBlob } from "./lib/e2e/download-flow.ts";
        import { openLink, fetchLinkListing } from "./lib/e2e/share-listing.ts";
        globalThis.__v2 = { tus, uploadEncrypted, downloadDecryptedV2, fetchShareBlob, openLink, fetchLinkListing };
      `,
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });

  const ctx = await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("format 4: " + e));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.addScriptTag({ content: bundle.outputFiles[0].text, type: "module" });
  await page.waitForFunction(() => globalThis.__v2 !== undefined, { timeout: 30_000 });

  const cases = [
    { label: "format 4 link share", sizes: [300 * 1024], maxDownloads: null },
    {
      label: "format 4 link-and-password share",
      sizes: [200 * 1024, 9],
      maxDownloads: 1,
      password: "correct horse battery",
    },
  ];
  for (const c of cases) {
    const r = await page.evaluate(format4RoundTrip, c);
    console.log(c.label + ":", r);
    if (r.error) fail(c.label + ": " + r.error);
  }
  if (errors.length) fail("page/console errors occurred (format 4)");
  await ctx.close();
  console.log("format 4: link and link-and-password shares listed and downloaded ✓");
}

// Runs in the page: upload with format 4, list from the uncounted header,
// download, compare. A limited share must still be unspent after the listing
// and gone after the download.
async function format4RoundTrip({ sizes, maxDownloads, password }) {
  const { tus, uploadEncrypted, downloadDecryptedV2, fetchShareBlob, openLink, fetchLinkListing } =
    globalThis.__v2;
  const random = (n) => {
    const b = new Uint8Array(n);
    for (let off = 0; off < n; off += 65536) crypto.getRandomValues(b.subarray(off, off + 65536));
    return b;
  };
  const files = sizes.map((n, i) => new File([random(n)], `v2-file-${i}.bin`, { type: "application/octet-stream" }));
  const originals = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const meta = async (slug) => {
    const res = await fetch(`/api/d/${slug}/meta`);
    return res.ok ? res.json() : { status: res.status };
  };

  const { shareUrl } = await uploadEncrypted(
    files,
    { expiry: "1d", maxDownloads, password, format: 4 },
    {
      baseUrl: location.origin,
      upload: (file) =>
        new Promise((resolve, reject) => {
          const up = new tus.Upload(file, {
            endpoint: "/files",
            onError: reject,
            onSuccess: () => resolve(up.url.split("/").pop()),
          });
          up.start();
        }),
      finalize: async (body) => {
        const res = await fetch("/api/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`finalize ${res.status}`);
        return res.json();
      },
    },
  );
  const url = new URL(shareUrl);
  const slug = url.pathname.split("/").pop();
  const token = url.hash.replace(/^#k=/, "");
  if (token.length !== 46) return { error: "not a v2 token: " + token };

  const before = await meta(slug);
  if (before.format !== 4) return { error: "meta format " + before.format };
  if (password) {
    const wrong = await openLink(token, before.format, "wrong horse battery");
    const refused = await fetchLinkListing(slug, wrong).then(
      () => false,
      (e) => /401/.test(String(e)),
    );
    if (!refused) return { error: "a wrong password listed the share" };
  }

  const link = await openLink(token, before.format, password);
  const listed = await fetchLinkListing(slug, link);
  const listOk =
    listed.length === files.length &&
    listed.every((f, i) => f.name === files[i].name && f.size === files[i].size);
  if (!listOk) return { error: "listing " + JSON.stringify(listed) };
  const afterListing = await meta(slug);
  if (afterListing.downloadsLeft !== before.downloadsLeft) {
    return { error: "the listing spent a download: " + afterListing.downloadsLeft };
  }

  const saved = [];
  await downloadDecryptedV2(fetchShareBlob(slug), link, async (plaintext, name) => {
    saved.push({ name, data: new Uint8Array(await new Response(plaintext).arrayBuffer()) });
  });
  const bytesMatch =
    saved.length === files.length &&
    saved.every((s, i) => s.name === files[i].name && equal(s.data, originals[i]));
  if (!bytesMatch) return { error: "downloaded bytes differ" };

  const after = await meta(slug);
  if (maxDownloads === 1 && after.status !== 404) return { error: "a once-only share survived its download" };
  return { files: listed.map((f) => `${f.name} ${f.size}`), bytesMatch, afterDownload: after.status ?? "kept" };
}
