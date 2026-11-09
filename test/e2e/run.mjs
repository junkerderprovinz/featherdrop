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
import { execFileSync } from "node:child_process";
import { inlineWorker } from "../inline-worker.mjs";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

// Reads a downloaded ZIP back with Info-ZIP's unzip: entry names in order and
// their bytes.
function unzipped(path) {
  const names = execFileSync("unzip", ["-Z1", path]).toString().split("\n").filter(Boolean);
  execFileSync("unzip", ["-tqq", path]);
  return names.map((name) => ({ name, data: execFileSync("unzip", ["-p", path, name], { maxBuffer: 1 << 30 }) }));
}
const tmp = mkdtempSync(join(tmpdir(), "fd-e2e-"));
const SRC = join(tmp, "e2e-secret.bin");
const payload = randomBytes(3 * 1024 * 1024);
writeFileSync(SRC, payload);

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
// The served client must start its crypto worker from a blob: URL, which the
// real CSP has to allow.
const workerUrls = [];
ctx.on("page", (p) => p.on("worker", (w) => workerUrls.push(w.url())));
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
  await format4RoundTrips(browser, ctx, errors, fail);
  await noteRoundTrips(ctx, errors, fail);
  await requestRoundTrip(ctx, errors, fail);
  if (workerUrls.length === 0 || !workerUrls.every((u) => u.startsWith("blob:"))) {
    fail("the crypto worker did not start from a blob: URL: " + JSON.stringify(workerUrls));
  }
  console.log("crypto workers:", workerUrls.length, "all from blob: URLs");
  // Last, because the limit switch is remembered for later uploads.
  await limitedShareListsBeforeDownload(ctx, errors, fail);

  console.log("E2E PASSED: zero-knowledge upload→download round trip verified");
} catch (e) {
  fail(String(e));
} finally {
  await browser.close();
}

// Three files uploaded together become one format 3 share. The share page has
// to list all three, "Download all" has to save one ZIP holding each
// byte-identical, and a single file can still be saved alone.
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
  while (downloads.length < 1 && Date.now() < deadline) {
    await dl.waitForTimeout(100);
  }
  await dl.waitForTimeout(500);
  if (downloads.length !== 1) fail("multi: expected one ZIP, got " + downloads.length + " downloads");
  const slug = new URL(shareUrl).pathname.split("/").pop();
  if (downloads[0].suggestedFilename() !== `${slug}.zip`) {
    fail("multi: ZIP named " + downloads[0].suggestedFilename());
  }
  const entries = unzipped(await downloads[0].path());
  if (entries.map((e) => e.name).join() !== files.map((f) => f.name).join()) {
    fail("multi: ZIP holds " + entries.map((e) => e.name));
  }
  for (const e of entries) {
    if (!e.data.equals(byName.get(e.name))) fail("multi: bytes for " + e.name + " do not match the original");
  }
  console.log("multi-file: Download all saved one ZIP with all 3 files ✓");

  // The second row's own download button saves that file alone.
  await dl.getByRole("button", { name: /^(download file|datei herunterladen)$/i }).nth(1).click();
  const one = Date.now() + 60_000;
  while (downloads.length < 2 && Date.now() < one) await dl.waitForTimeout(100);
  if (downloads.length !== 2 || downloads[1].suggestedFilename() !== "tiny.txt") {
    fail("multi: picking tiny.txt saved " + downloads.slice(1).map((d) => d.suggestedFilename()));
  }
  if (!readFileSync(await downloads[1].path()).equals(byName.get("tiny.txt"))) {
    fail("multi: tiny.txt picked alone does not match");
  }
  if (errors.length) fail("page/console errors occurred (multi-file)");
  console.log("multi-file: a single file picked from the list matches ✓");
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

// The upload page does not write format 4 yet, so these shares are uploaded
// through the client library, bundled and loaded into a page of the app whose
// context skips the CSP that would block the injected module. Listing and
// download then go through the real download page.
async function format4RoundTrips(browser, ctx, errors, fail) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const bundle = await build({
    stdin: {
      contents: `
        import { uploadEncrypted, resumeUpload } from "./lib/e2e/upload-flow.ts";
        import { tusUpload } from "./lib/e2e/tus-upload.ts";
        import { listPendingUploads, indexedDbResumeStore } from "./lib/e2e/upload-resume.ts";
        import { openLink, fetchLinkListing } from "./lib/e2e/share-listing.ts";
        import { cryptoWorker } from "./lib/e2e/v2/crypto-worker.ts";
        // An upload that keeps a resume record and sends 1 MiB per request.
        const resumeDeps = () => ({
          baseUrl: location.origin,
          crypto: cryptoWorker,
          resume: indexedDbResumeStore(),
          upload: (source, o) => tusUpload(source, { ...o, chunkSize: 1024 * 1024 }),
          finalize: async (body) => {
            const res = await fetch("/api/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error("finalize " + res.status);
            return res.json();
          },
        });
        globalThis.__v2 = { tusUpload, uploadEncrypted, resumeUpload, listPendingUploads, resumeDeps, openLink, fetchLinkListing, cryptoWorker };
      `,
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [inlineWorker],
  });

  const libCtx = await browser.newContext({ bypassCSP: true });
  const openLib = async () => {
    const page = await libCtx.newPage();
    page.on("pageerror", (e) => errors.push("format 4 lib: " + e));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.addScriptTag({ content: bundle.outputFiles[0].text, type: "module" });
    await page.waitForFunction(() => globalThis.__v2 !== undefined, { timeout: 30_000 });
    return page;
  };
  const lib = await openLib();

  const cases = [
    {
      label: "format 4 link share",
      files: [{ name: "v2-film.bin", data: randomBytes(300 * 1024) }],
      maxDownloads: null,
    },
    {
      label: "format 4 link-and-password share",
      files: [
        { name: "v2-a.bin", data: randomBytes(200 * 1024) },
        { name: "v2-b.txt", data: randomBytes(9) },
      ],
      maxDownloads: 1,
      password: "correct horse battery",
    },
    {
      label: "format 4 bundle without a limit",
      files: [
        { name: "v2-x.bin", data: randomBytes(150 * 1024) },
        { name: "v2-y.bin", data: randomBytes(70 * 1024) },
        { name: "v2-z.txt", data: randomBytes(5) },
      ],
      maxDownloads: null,
      pick: 1,
    },
  ];
  for (const c of cases) {
    const spec = {
      files: c.files.map((f) => ({ name: f.name, b64: f.data.toString("base64") })),
      maxDownloads: c.maxDownloads,
      password: c.password,
    };
    const up = await lib.evaluate(uploadAndListV2, spec);
    if (up.error) fail(c.label + ": " + up.error);
    console.log(c.label + ": listed from the header", up.listed);

    const dl = await ctx.newPage();
    dl.on("pageerror", (e) => errors.push("format 4 dl: " + e));
    dl.on("console", (m) => {
      if (m.type() === "error") errors.push("format 4 dl console: " + m.text());
    });
    const downloads = [];
    dl.on("download", (d) => downloads.push(d));
    const sent = [];
    dl.on("request", (r) => sent.push([r.method(), r.url(), r.postData() ?? "", JSON.stringify(r.headers())].join(" ")));
    await dl.goto(up.shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const slug = new URL(up.shareUrl).pathname.split("/").pop();
    const bundle = c.files.length > 1;
    const waitFor = async (n) => {
      const deadline = Date.now() + 120_000;
      while (downloads.length < n && Date.now() < deadline) await dl.waitForTimeout(100);
      if (downloads.length !== n) fail(`${c.label}: ${downloads.length} downloads, expected ${n}`);
    };
    if (c.password) {
      await dl.locator('input[type="password"]').fill(c.password);
      await dl.getByRole("button", { name: /unlock|entsperren/i }).click();
    } else {
      await dl.getByText(c.files[0].name, { exact: true }).waitFor({ timeout: 120_000 });
      if (c.pick !== undefined) {
        const want = c.files[c.pick];
        await dl.getByRole("button", { name: /^(download file|datei herunterladen)$/i }).nth(c.pick).click();
        await waitFor(1);
        const picked = downloads.shift();
        if (picked.suggestedFilename() !== want.name || !readFileSync(await picked.path()).equals(want.data)) {
          fail(`${c.label}: picking ${want.name} saved ${picked.suggestedFilename()}`);
        }
        console.log(c.label + ": a single file picked alone matches ✓");
      }
      const name = bundle ? /^(download all|alle herunterladen)$/i : /^(download file|datei herunterladen)$/i;
      await dl.getByRole("button", { name }).last().click();
    }
    await waitFor(1);
    await dl.waitForTimeout(500);
    if (downloads.length !== 1) fail(`${c.label}: ${downloads.length} downloads, expected one`);
    const got = await downloads[0].path();
    if (bundle) {
      if (downloads[0].suggestedFilename() !== `${slug}.zip`) fail(`${c.label}: ZIP named ${downloads[0].suggestedFilename()}`);
      const entries = unzipped(got);
      if (entries.length !== c.files.length) fail(`${c.label}: ZIP holds ${entries.map((e) => e.name)}`);
      for (const [i, e] of entries.entries()) {
        if (e.name !== c.files[i].name || !e.data.equals(c.files[i].data)) {
          fail(`${c.label}: ${e.name} in the ZIP does not match ${c.files[i].name}`);
        }
      }
    } else if (downloads[0].suggestedFilename() !== c.files[0].name || !readFileSync(got).equals(c.files[0].data)) {
      fail(`${c.label}: ${downloads[0].suggestedFilename()} does not match ${c.files[0].name}`);
    }
    for (const f of c.files) {
      if (c.files.length > 1) await dl.getByText(f.name, { exact: true }).waitFor({ timeout: 10_000 });
    }

    if (c.password && sent.some((r) => r.includes(c.password) || r.startsWith("POST"))) {
      fail(c.label + ": the page sent the password or posted something");
    }

    const meta = await dl.request.get(`${BASE}/api/d/${slug}/meta`);

    if (c.maxDownloads === 1 && meta.status() !== 404) fail(c.label + ": once-only share survived");
    console.log(c.label + ": downloaded through the page, bytes match ✓");
  }
  if (errors.length) fail("page/console errors occurred (format 4)");
  await resumeAfterClosedTab(ctx, libCtx, openLib, errors, fail);
  await libCtx.close();
}

// A format 4 upload whose tab closes after its first tus request goes on in a
// new tab once the same file is picked again, and the share it finalizes
// downloads intact through the page.
async function resumeAfterClosedTab(ctx, libCtx, openLib, errors, fail) {
  const data = randomBytes(3 * 1024 * 1024 + 4321);
  const spec = { name: "resumed.bin", b64: data.toString("base64"), lastModified: 1_700_000_000_000 };

  const first = await openLib();
  const offsets = [];
  // Every request after the first chunk is left hanging, as if the tab died.
  await first.route("**/files/**", (route) => {
    const offset = Number(route.request().headers()["upload-offset"] ?? 0);
    if (route.request().method() === "PATCH") offsets.push(offset);
    if (route.request().method() === "PATCH" && offset > 0) return;
    return route.continue();
  });
  first.evaluate(startResumableUpload, spec).catch(() => {});
  const deadline = Date.now() + 60_000;
  while (offsets.length < 2 && Date.now() < deadline) await first.waitForTimeout(100);
  if (offsets.length < 2) fail("resume: the first upload never reached its second chunk");
  await first.close();

  const second = await openLib();
  const sent = [];
  second.on("request", (r) => {
    if (r.method() === "PATCH") sent.push(Number(r.headers()["upload-offset"]));
  });
  const res = await second.evaluate(resumeUploadInPage, spec);
  if (res.error) fail("resume: " + res.error);
  // tusd keeps what arrived of a request cut off mid-body, so the offset can
  // lie past the first chunk; it must not be back at the start.
  if (!(sent[0] >= 1024 * 1024)) fail("resume: the second tab started at offset " + sent[0]);
  console.log("resume: the second tab went on at offset " + sent[0]);
  await second.close();

  const dl = await ctx.newPage();
  dl.on("pageerror", (e) => errors.push("resume dl: " + e));
  const downloads = [];
  dl.on("download", (d) => downloads.push(d));
  await dl.goto(res.shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await dl.getByText("resumed.bin", { exact: true }).waitFor({ timeout: 120_000 });
  await dl.getByRole("button", { name: /^(download file|datei herunterladen)$/i }).click();
  const until = Date.now() + 120_000;
  while (downloads.length < 1 && Date.now() < until) await dl.waitForTimeout(100);
  if (downloads.length !== 1 || !readFileSync(await downloads[0].path()).equals(data)) {
    fail("resume: the resumed share does not download as the original");
  }
  if (errors.length) fail("page/console errors occurred (resume)");
  console.log("resume: an upload cut off with its tab went on in a new tab and downloads intact ✓");
}

// Runs in the page; never settles, since its tab is closed mid-upload.
async function startResumableUpload({ name, b64, lastModified }) {
  const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { lastModified });
  await globalThis.__v2.uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, globalThis.__v2.resumeDeps());
}

// Runs in the page: list the pending upload, pick the same file, resume.
async function resumeUploadInPage({ name, b64, lastModified }) {
  const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { lastModified });
  const deps = globalThis.__v2.resumeDeps();
  const pending
 = await globalThis.__v2.listPendingUploads(deps.resume);
  if (pending.length !== 1) return { error: "pending uploads: " + JSON.stringify(pending) };
  if (pending[0].files[0].name !== name) return { error: "pending lists " + JSON.stringify(pending[0].files) };
  const { shareUrl } = await globalThis.__v2.resumeUpload(pending[0].id, [file], deps);
  const left = await globalThis.__v2.listPendingUploads(deps.resume);
  if (left.length !== 0) return { error: "the record outlived its upload" };
  return { shareUrl };
}


// Runs in the page: upload with format 4, check that a wrong password gets
// no listing, list from the uncounted header and check nothing was spent.
async function uploadAndListV2({ files: specs, maxDownloads, password }) {
  const { tusUpload, uploadEncrypted, openLink, fetchLinkListing, cryptoWorker } = globalThis.__v2;
  const files = specs.map(
    (f) => new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name),
  );
  const meta = async (slug) => (await fetch(`/api/d/${slug}/meta`)).json();

  const { shareUrl } = await uploadEncrypted(
    files,
    { expiry: "1d", maxDownloads, password, format: 4 },
    {
      baseUrl: location.origin,
      crypto: cryptoWorker,
      upload: (source, { onProgress }) => tusUpload(source, { onProgress }),
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
    const wrong = await openLink(token, 4, "wrong horse battery");
    const refused = await fetchLinkListing(slug, wrong).then(
      () => false,
      (e) => /401/.test(String(e)),
    );
    if (!refused) return { error: "a wrong password listed the share" };
  }
  const listed = await fetchLinkListing(slug, await openLink(token, 4, password));
  if (!listed.every((f, i) => f.name === files[i].name && f.size === files[i].size)) {
    return { error: "listing " + JSON.stringify(listed) };
  }
  const after = await meta(slug);
  if (after.downloadsLeft !== before.downloadsLeft) {
    return { error: "the listing spent a download: " + after.downloadsLeft };
  }
  return { shareUrl, listed: listed.map((f) => `${f.name} ${f.size}`) };
}

function watch(page, label, errors) {
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
  });
  return page;
}

async function waitForLink(page, part) {
  await page.waitForFunction(
    (p) => [...document.querySelectorAll("input[readonly]")].some((i) => i.value.includes(p)),
    part,
    { timeout: 120_000 },
  );
  return (await readonlyValue(page, part)).trim();
}

// A note written on /note and read on the share page, once in link mode and
// once with a password and a single download. The page must show markup in a
// note as text and never run it.
async function noteRoundTrips(ctx, errors, fail) {
  const cases = [
    { label: "note", password: "", once: false },
    { label: "note with password", password: "correct horse battery", once: true },
  ];
  for (const c of cases) {
    const note = `<img src=x onerror="window.__pwned=1">\n${c.label}: the gate code is 4711 🏰`;
    const up = watch(await ctx.newPage(), `${c.label} up`, errors);
    await up.goto(`${BASE}/note`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await up.getByPlaceholder(/type or paste your note|notiz eintippen/i).fill(note);
    if (c.password) await up.locator('input[type="password"]').fill(c.password);
    if (c.once) await up.getByLabel(/max downloads|max\. downloads/i).fill("1");
    await up.getByRole("button", { name: /encrypt and share|verschlüsseln und teilen/i }).click();
    const shareUrl = await waitForLink(up, "/d/");
    if (!shareUrl.includes("#k=")) fail(`${c.label}: link without a key: ${shareUrl}`);

    const dl = watch(await ctx.newPage(), `${c.label} dl`, errors);
    await dl.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    if (c.password) {
      await dl.locator('input[type="password"]').fill(c.password);
      await dl.getByRole("button", { name: /unlock|entsperren/i }).click();
    } else {
      await dl.getByRole("button", { name: /show note|notiz anzeigen/i }).click();
    }
    await dl.locator("pre").waitFor({ timeout: 120_000 });
    const shown = await dl.evaluate(() => ({
      text: document.querySelector("pre")?.textContent ?? "",
      images: document.querySelectorAll("pre img").length,
      pwned: globalThis.__pwned === 1,
    }));
    if (shown.text !== note) fail(`${c.label}: shown ${JSON.stringify(shown.text)}`);
    if (shown.images !== 0 || shown.pwned) fail(`${c.label}: the note was rendered as HTML`);

    const slug = new URL(shareUrl).pathname.split("/").pop();
    // The server burns a used-up share once it has sent the last byte, which
    // can land just after the page has shown the note.
    let meta = await dl.request.get(`${BASE}/api/d/${slug}/meta`);
    for (let i = 0; c.once && meta.status() !== 404 && i < 50; i++) {
      await dl.waitForTimeout(100);
      meta = await dl.request.get(`${BASE}/api/d/${slug}/meta`);
    }
    if (c.once && meta.status() !== 404) fail(`${c.label}: a once-only note survived its reading`);
    if (!c.once && meta.status() !== 200) fail(`${c.label}: meta ${meta.status()}`);
    if (!c.once && (await meta.json()).format !== 4) fail(`${c.label}: not a format 4 share`);
    console.log(`${c.label}: written, read as text, never as HTML ✓`);
  }
  if (errors.length) fail("page/console errors occurred (notes)");
}

// A file request opened on /request, filled on the request link's page and
// collected on the collect link's page. The request link alone must not list
// anything.
async function requestRoundTrip(ctx, errors, fail) {
  const files = [
    { name: "asked-for.bin", mimeType: "application/octet-stream", buffer: randomBytes(150 * 1024) },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("a second file") },
  ];
  const req = watch(await ctx.newPage(), "request", errors);
  await req.goto(`${BASE}/request`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await req.getByRole("button", { name: /create request|anfrage erstellen/i }).click();
  const requestUrl = await waitForLink(req, "/r/");
  const collectUrl = await waitForLink(req, "/c/");
  if (!requestUrl.includes("#p=") || !collectUrl.includes("#c=")) fail("request links without their keys");
  const slug = new URL(requestUrl).pathname.split("/").pop();
  if (new URL(collectUrl).pathname.split("/").pop() !== slug) fail("the two links name different requests");

  const send = watch(await ctx.newPage(), "send", errors);
  await send.goto(requestUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await send.locator('input[type="file"]').setInputFiles(files);
  await send.getByRole("button", { name: /encrypt and send|verschlüsseln und senden/i }).click();
  await send.getByText(/^sent\.|^gesendet\./i).waitFor({ timeout: 120_000 });

  // What someone with only the request link can try against the API.
  const requestKey = Buffer.from(new URL(requestUrl).hash.slice(3), "base64url").subarray(2).toString("base64url");
  for (const [path, headers] of [
    [`/api/r/${slug}/uploads`, { "x-fd-request-key": requestKey }],
    [`/api/r/${slug}/uploads`, { "x-fd-collect-token": requestKey }],
    [`/api/r/${slug}`, {}],
  ]) {
    const res = await send.request.get(`${BASE}${path}`, { headers });
    if (res.status() !== 404) fail(`request link reached ${path}: ${res.status()}`);
  }
  const info = await send.request.get(`${BASE}/api/r/${slug}`, { headers: { "x-fd-request-key": requestKey } });
  const infoKeys = Object.keys(await info.json()).sort().join(",");
  if (infoKeys !== "expiresAt,maxSize,open") fail("the uploader learns " + infoKeys);

  const col = watch(await ctx.newPage(), "collect", errors);
  const downloads = [];
  col.on("download", (d) => downloads.push(d));
  await col.goto(collectUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  for (const f of files) await col.getByText(f.name, { exact: true }).waitFor({ timeout: 120_000 });
  await col.getByRole("button", { name: /^(download file|datei herunterladen)$/i }).click();
  const deadline = Date.now() + 120_000;
  while (downloads.length < 1 && Date.now() < deadline) await col.waitForTimeout(100);
  if (downloads.length !== 1) fail(`request: ${downloads.length} downloads, want one ZIP`);
  const entries = unzipped(await downloads[0].path());
  if (entries.length !== files.length) fail(`request: the ZIP holds ${entries.length} files`);
  for (const [i, e] of entries.entries()) {
    if (e.name !== files[i].name || !e.data.equals(files[i].buffer)) {
      fail(`request: ${e.name} does not match ${files[i].name}`);
    }
  }

  await col.getByRole("button", { name: /close request|anfrage schließen/i }).click();
  await col.getByRole("button", { name: /click again to confirm|zum bestätigen erneut klicken/i }).click();
  await col.getByText(/request closed|anfrage geschlossen/i).waitFor({ timeout: 30_000 });
  // The closed request answers 404, which the browser logs, so only page
  // errors count here.
  const after = await ctx.newPage();
  after.on("pageerror", (e) => errors.push("collect after close: " + e));
  await after.goto(collectUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await after.getByText(/has expired, or the link is incomplete|abgelaufen oder der link/i).waitFor({ timeout: 30_000 });
  if (errors.length) fail("page/console errors occurred (request)");
  console.log("request: sent through the request link, collected and closed through the collect link ✓");
}
