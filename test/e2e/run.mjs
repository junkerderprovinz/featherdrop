// End-to-end test against the running app, built and started in CI: pick
// files, encrypt, upload with tus, finalize, open the link, decrypt, download,
// compare the bytes, through the real pages. The run makes more share
// requests than one address may send per minute, so the server needs
// RATE_LIMIT=false.
import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { inlineWorker } from "../inline-worker.mjs";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const WAIT = { timeout: 120_000 };

// Reads a downloaded ZIP back with Info-ZIP's unzip: entry names in order and
// their bytes.
function unzipped(path) {
  const names = execFileSync("unzip", ["-Z1", path]).toString().split("\n").filter(Boolean);
  execFileSync("unzip", ["-tqq", path]);
  return names.map((name) => ({ name, data: execFileSync("unzip", ["-p", path, name], { maxBuffer: 1 << 30 }) }));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
// The served client must start its crypto worker from a blob: URL, which the
// real CSP has to allow.
const workerUrls = [];
ctx.on("page", (p) => p.on("worker", (w) => workerUrls.push(w.url())));
const errors = [];

function fail(msg) {
  console.error("E2E FAILED:", msg, "| pageErrors:", errors);
  process.exit(1);
}

// expected names a refusal the scenario provokes, which the browser logs as
// a console error.
function watch(page, label, expected) {
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !(expected && expected.test(m.text()))) errors.push(`${label} console: ${m.text()}`);
  });
  return page;
}

async function open(label, url, expected) {
  const page = watch(await ctx.newPage(), label, expected);
  await page.goto(url, { waitUntil: "domcontentloaded", ...WAIT });
  return page;
}

// The link fields are read-only inputs; part tells the share, management,
// request and collect links apart.
async function waitForLink(page, part) {
  await page.waitForFunction((p) => [...document.querySelectorAll("input[readonly]")].some((i) => i.value.includes(p)), part, WAIT);
  return page.evaluate((p) => [...document.querySelectorAll("input[readonly]")].find((i) => i.value.includes(p)).value.trim(), part);
}

// Waits until n downloads have arrived, then a little longer, so a stray
// second one would be counted too.
async function downloadsOf(page, list, n, label) {
  const deadline = Date.now() + 120_000;
  while (list.length < n && Date.now() < deadline) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  if (list.length !== n) fail(`${label}: ${list.length} downloads, expected ${n}`);
}

const slugOf = (url) => new URL(url).pathname.split("/").pop();
const meta = (page, slug) => page.request.get(`${BASE}/api/d/${slug}/meta`);

/**
 * Sends files through the start page with the given options and returns the
 * upload page, the share link and the management link.
 */
async function share(label, files, { once = false, password = "" } = {}) {
  const page = await open(`${label} up`, BASE);
  await page.setInputFiles('input[type="file"]', files);
  if (once) await page.locator("[data-cp=limit-once]").click();
  if (password) {
    await page.locator("[data-cp=lock]").click();
    await page.locator('input[type="password"]').fill(password);
  }
  await page.locator("[data-cp=upload]").click();
  const shareUrl = await waitForLink(page, "/d/").catch(async () =>
    fail(`${label}: no share link appeared. alerts=${JSON.stringify(await page.locator("[role=alert]").allInnerTexts())}`),
  );
  if (!shareUrl.includes("#k=")) fail(`${label}: share link without its key: ${shareUrl}`);
  return { page, shareUrl, manageUrl: await waitForLink(page, "/m/") };
}

try {
  await singleFileRoundTrip();
  await multiFileRoundTrip();
  await previewOfAnImage();
  await passwordShareRoundTrip();
  await passwordTooShortIsExplained();
  await olderFormatsStillOpen();
  // Resuming needs crypto.subtle, which a page on plain HTTP does not have.
  if (await secureBase()) {
    await resumeAfterClosedTab();
    await resumeDialogOnTheStartPage();
  } else {
    console.log("resume: skipped, " + BASE + " is not a secure context");
  }
  await plainHttpUpload();
  await noteRoundTrips();
  await requestRoundTrip();
  if (workerUrls.length === 0 || !workerUrls.every((u) => u.startsWith("blob:"))) {
    fail("the crypto worker did not start from a blob: URL: " + JSON.stringify(workerUrls));
  }
  console.log("crypto workers:", workerUrls.length, "all from blob: URLs");
  await limitedShareListsBeforeDownload();
  await startPageShortcuts();
  await wayOutSitsInTheHead();
  await infoTabStaysInSettings();
  await castleLoaderPlays();
  if (errors.length) fail("page/console errors occurred");
  console.log("E2E PASSED: zero-knowledge upload→download round trip verified");
} catch (e) {
  fail(String(e));
} finally {
  await browser.close();
}

// One file, link mode: the share page names it and the download matches.
// The management link then deletes the share for good.
async function singleFileRoundTrip() {
  const payload = randomBytes(3 * 1024 * 1024);
  const { page: up, shareUrl, manageUrl } = await share("single", { name: "e2e-secret.bin", mimeType: "application/octet-stream", buffer: payload });
  console.log("share url:", shareUrl);
  const slug = slugOf(shareUrl);
  if ((await (await meta(up, slug)).json()).format !== 4) fail("the upload page did not write format 4");

  const dl = await open("single dl", shareUrl);
  await dl.getByText("e2e-secret.bin", { exact: true }).waitFor(WAIT);
  const [download] = await Promise.all([dl.waitForEvent("download", WAIT), dl.locator("[data-cp=download-all]").click()]);
  const got = readFileSync(await download.path());
  if (download.suggestedFilename() !== "e2e-secret.bin") fail("filename mismatch: " + download.suggestedFilename());
  if (!got.equals(payload)) fail("decrypted bytes do not match the original");
  console.log("single file: format 4 link share downloads byte for byte ✓");

  if (!manageUrl.includes("#t=")) fail("management link without #t=: " + manageUrl);
  if (manageUrl.split("#t=")[1] === shareUrl.split("#k=")[1]) fail("the management token must differ from the link token");
  const manage = await open("manage", manageUrl);
  await manage.locator("[data-cp=delete]").click();
  await manage.getByRole("dialog").getByRole("button", { name: /delete share/i }).click();
  await manage.locator("[data-cp=manage-end]").getByText(/share deleted/i).first().waitFor({ timeout: 30_000 });
  if ((await meta(manage, slug)).status() !== 404) fail("share still there after revoke");
  console.log("revoke: management link deleted the share ✓");
}

// Three files become one format 4 bundle. The page lists all three, "Download
// all" saves one ZIP holding each byte for byte, and a single file of the
// unlimited share can still be saved alone.
async function multiFileRoundTrip() {
  const files = [
    { name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(200 * 1024) },
    { name: "tiny.txt", mimeType: "text/plain", buffer: randomBytes(7) },
    { name: "middle.dat", mimeType: "application/octet-stream", buffer: randomBytes(40 * 1024) },
  ];
  const { shareUrl } = await share("multi", files);
  const dl = await open("multi dl", shareUrl);
  const downloads = [];
  dl.on("download", (d) => downloads.push(d));
  for (const f of files) await dl.getByText(f.name, { exact: true }).waitFor(WAIT);
  console.log("multi: file list shows all 3 entries ✓");

  await dl.locator("[data-cp=download-all]").click();
  await downloadsOf(dl, downloads, 1, "multi");
  if (downloads[0].suggestedFilename() !== `${slugOf(shareUrl)}.zip`) fail("multi: ZIP named " + downloads[0].suggestedFilename());
  const entries = unzipped(await downloads[0].path());
  if (entries.map((e) => e.name).join() !== files.map((f) => f.name).join()) fail("multi: ZIP holds " + entries.map((e) => e.name));
  for (const [i, e] of entries.entries()) if (!e.data.equals(files[i].buffer)) fail("multi: bytes for " + e.name + " do not match");
  console.log("multi-file: Download all saved one ZIP with all 3 files ✓");

  await dl.locator("[data-cp=download-one]").nth(1).click();
  await downloadsOf(dl, downloads, 2, "multi pick");
  if (downloads[1].suggestedFilename() !== "tiny.txt" || !readFileSync(await downloads[1].path()).equals(files[1].buffer)) {
    fail("multi: picking tiny.txt saved " + downloads[1].suggestedFilename());
  }
  console.log("multi-file: a single file picked from the list matches ✓");
}

// A tiny PNG shows as its own thumbnail and opens in the preview window, both
// from blob: URLs decrypted in the page.
async function previewOfAnImage() {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const { shareUrl } = await share("preview", [
    { name: "preview.png", mimeType: "image/png", buffer: PNG },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain <b>text</b>") },
  ]);
  const page = await open("preview", shareUrl);
  await page.waitForSelector('[data-cp=files] img[src^="blob:"]', WAIT);
  await page.locator("[data-cp=preview]").first().click();
  await page.waitForSelector('[data-cp=preview-body] img[src^="blob:"]', WAIT);
  await page.keyboard.press("ArrowRight");
  await page.locator("[data-cp=preview-body] pre").getByText("plain <b>text</b>").waitFor(WAIT);
  console.log("preview: image and text previewed from blob: URLs ✓");
}

// A link-and-password share asks for the password, refuses a wrong one, and
// once unlocked a once-only bundle downloads as one ZIP and is gone. The page
// never sends the password anywhere.
async function passwordShareRoundTrip() {
  const password = "correct horse battery";
  const files = [
    { name: "v2-a.bin", mimeType: "application/octet-stream", buffer: randomBytes(200 * 1024) },
    { name: "v2-b.txt", mimeType: "text/plain", buffer: randomBytes(9) },
  ];
  const { shareUrl } = await share("password", files, { once: true, password });
  const token = new URL(shareUrl).hash.replace(/^#k=/, "");
  if (token.length !== 46) fail("not a v2 token: " + token);

  const dl = await open("password dl", shareUrl, /status of 401/);
  const downloads = [];
  dl.on("download", (d) => downloads.push(d));
  const sent = [];
  dl.on("request", (r) => sent.push([r.method(), r.url(), r.postData() ?? "", JSON.stringify(r.headers())].join(" ")));
  const field = dl.locator('input[type="password"]');
  await field.fill("wrong horse battery");
  await dl.locator("[data-cp=unlock]").click();
  await dl.getByRole("alert").getByText(/did not open/i).waitFor(WAIT);
  await field.fill(password);
  await dl.locator("[data-cp=unlock]").click();
  for (const f of files) await dl.getByText(f.name, { exact: true }).waitFor(WAIT);
  if (await dl.locator("[data-cp=download-one]").count()) fail("a once-only share offers single files");
  await dl.locator("[data-cp=download-all]").click();
  await downloadsOf(dl, downloads, 1, "password");
  const entries = unzipped(await downloads[0].path());
  for (const [i, e] of entries.entries()) {
    if (e.name !== files[i].name || !e.data.equals(files[i].buffer)) fail(`password: ${e.name} does not match`);
  }
  if (sent.some((r) => r.includes(password) || r.startsWith("POST"))) fail("password: the page sent the password or posted something");
  await dl.locator("[data-cp=gone]").getByText(/already downloaded/i).waitFor(WAIT);
  if ((await meta(dl, slugOf(shareUrl))).status() !== 404) fail("password: once-only share survived");
  console.log("format 4 link-and-password share: wrong password refused, bundle downloaded, share gone ✓");
}

// A share password under 8 characters is explained and cannot be sent.
async function passwordTooShortIsExplained() {
  const page = await open("short password", BASE);
  await page.setInputFiles('input[type="file"]', { name: "short.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.locator("[data-cp=lock]").click();
  const field = page.locator('input[type="password"]');
  await field.fill("seven77");
  await page.locator("[data-cp=password-short]").getByText(/at least 8 characters/i).waitFor(WAIT);
  if (!(await page.locator("[data-cp=upload]").isDisabled())) fail("short password: the upload button stays enabled");
  await field.fill("eight888");
  await page.locator("[data-cp=password-short]").waitFor({ state: "detached", ...WAIT });
  if (await page.locator("[data-cp=upload]").isDisabled()) fail("short password: eight characters are refused");
  await page.close();
  console.log("password too short: explained, upload held back until 8 characters ✓");
}

async function secureBase() {
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", ...WAIT });
  const secure = await page.evaluate(() => window.isSecureContext);
  await page.close();
  return secure;
}

// A page on plain HTTP under a name other than localhost is no secure
// context, so it has no crypto.subtle for the sealed resume record. The
// upload still goes through, the page says while it runs that resuming needs
// HTTPS, and the share downloads without the service worker.
async function plainHttpUpload() {
  const url = new URL(BASE);
  const plain = await chromium.launch({ args: [`--host-resolver-rules=MAP castle.test ${url.hostname}`] });
  const pctx = await plain.newContext({ acceptDownloads: true });
  // Chromium notes that it ignores the opener policy on an insecure origin.
  const coop = /Cross-Origin-Opener-Policy header has been ignored/;
  const page = watch(await pctx.newPage(), "plain http", coop);
  const base = `http://castle.test:${url.port || 80}`;
  await page.goto(base, { waitUntil: "domcontentloaded", ...WAIT });
  if (await page.evaluate(() => window.isSecureContext)) fail("plain http: castle.test counts as a secure context");
  const held = [];
  await page.route("**/files/**", (route) => (route.request().method() === "PATCH" ? held.push(route) : route.continue()));
  const data = randomBytes(256 * 1024);
  await page.setInputFiles('input[type="file"]', { name: "plain.bin", mimeType: "application/octet-stream", buffer: data });
  await page.locator("[data-cp=upload]").click();
  await page.locator("[data-cp=no-resume]").getByText(/needs HTTPS/i).waitFor(WAIT);
  await page.unroute("**/files/**");
  for (const route of held) await route.continue();
  const shareUrl = (await waitForLink(page, "/d/")).replace(BASE, base);
  const dl = watch(await pctx.newPage(), "plain http dl", coop);
  await dl.goto(shareUrl, { waitUntil: "domcontentloaded", ...WAIT });
  await dl.getByText("plain.bin", { exact: true }).waitFor(WAIT);
  const [download] = await Promise.all([dl.waitForEvent("download", WAIT), dl.locator("[data-cp=download-all]").click()]);
  if (!readFileSync(await download.path()).equals(data)) fail("plain http: the download does not match");
  await plain.close();
  console.log("plain http: the upload went through without a resume record, the page said why ✓");
}

// The client library, bundled and loaded into a page of the app whose context
// skips the CSP that would block the injected module. It writes the older
// formats the upload page no longer writes, and drives a format 4 upload with
// small tus requests so one can be cut off.
async function libraryPage() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const bundle = await build({
    stdin: {
      contents: `
        import { uploadEncrypted, resumeUpload } from "./lib/e2e/upload-flow.ts";
        import { tusUpload } from "./lib/e2e/tus-upload.ts";
        import { listPendingUploads, indexedDbResumeStore } from "./lib/e2e/upload-resume.ts";
        import { cryptoWorker } from "./lib/e2e/v2/crypto-worker.ts";
        const deps = (resume) => ({
          baseUrl: location.origin,
          crypto: cryptoWorker,
          resume: resume ? indexedDbResumeStore() : undefined,
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
        globalThis.__lib = { uploadEncrypted, resumeUpload, listPendingUploads, deps };
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
  return {
    libCtx,
    async page() {
      const page = await libCtx.newPage();
      page.on("pageerror", (e) => errors.push("library: " + e));
      await page.goto(BASE, { waitUntil: "domcontentloaded", ...WAIT });
      await page.addScriptTag({ content: bundle.outputFiles[0].text, type: "module" });
      await page.waitForFunction(() => globalThis.__lib !== undefined, null, { timeout: 30_000 });
      return page;
    },
  };
}

// Shares of formats 2 and 3, as earlier releases wrote them, still list,
// preview and download on the share page.
async function olderFormatsStillOpen() {
  const lib = await libraryPage();
  const writer = await lib.page();
  const cases = [
    { label: "format 2", files: [{ name: "old-single.bin", data: randomBytes(150 * 1024) }] },
    {
      label: "format 3",
      files: [
        { name: "old-a.bin", data: randomBytes(90 * 1024) },
        { name: "old-b.txt", data: Buffer.from("an older bundle") },
      ],
    },
  ];
  for (const c of cases) {
    const shareUrl = await writer.evaluate(async (specs) => {
      const files = specs.map((f) => new File([Uint8Array.from(atob(f.b64), (ch) => ch.charCodeAt(0))], f.name));
      return (await globalThis.__lib.uploadEncrypted(files, { expiry: "1d", maxDownloads: null }, globalThis.__lib.deps(false))).shareUrl;
    }, c.files.map((f) => ({ name: f.name, b64: f.data.toString("base64") })));
    const format = (await (await meta(writer, slugOf(shareUrl))).json()).format;
    if (format !== (c.files.length > 1 ? 3 : 2)) fail(`${c.label}: the library wrote format ${format}`);

    const dl = await open(`${c.label} dl`, shareUrl);
    const downloads = [];
    dl.on("download", (d) => downloads.push(d));
    for (const f of c.files) await dl.getByText(f.name, { exact: true }).waitFor(WAIT);
    await dl.locator("[data-cp=download-all]").click();
    await downloadsOf(dl, downloads, 1, c.label);
    const got = await downloads[0].path();
    if (c.files.length > 1) {
      const entries = unzipped(got);
      for (const [i, e] of entries.entries()) if (!e.data.equals(c.files[i].data)) fail(`${c.label}: ${e.name} does not match`);
    } else if (!readFileSync(got).equals(c.files[0].data)) {
      fail(`${c.label}: the download does not match`);
    }
    console.log(`${c.label}: an older share lists and downloads byte for byte ✓`);
  }
  await lib.libCtx.close();
}

// A format 4 upload whose tab closes after its first tus request goes on in
// a new tab once the same file is picked again, and the share it finalizes
// downloads intact through the page.
async function resumeAfterClosedTab() {
  const lib = await libraryPage();
  const data = randomBytes(3 * 1024 * 1024 + 4321);
  const spec = { name: "resumed.bin", b64: data.toString("base64"), lastModified: 1_700_000_000_000 };

  const first = await lib.page();
  const offsets = [];
  // Every request after the first chunk is left hanging, as if the tab died.
  await first.route("**/files/**", (route) => {
    const offset = Number(route.request().headers()["upload-offset"] ?? 0);
    if (route.request().method() === "PATCH") offsets.push(offset);
    if (route.request().method() === "PATCH" && offset > 0) return;
    return route.continue();
  });
  first
    .evaluate(async ({ name, b64, lastModified }) => {
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { lastModified });
      await globalThis.__lib.uploadEncrypted([file], { expiry: "1d", maxDownloads: null, format: 4 }, globalThis.__lib.deps(true));
    }, spec)
    .catch(() => {});
  const deadline = Date.now() + 60_000;
  while (offsets.length < 2 && Date.now() < deadline) await first.waitForTimeout(100);
  if (offsets.length < 2) fail("resume: the first upload never reached its second chunk");
  await first.close();

  const second = await lib.page();
  const sent = [];
  second.on("request", (r) => {
    if (r.method() === "PATCH") sent.push(Number(r.headers()["upload-offset"]));
  });
  const res = await second.evaluate(async ({ name, b64, lastModified }) => {
    const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { lastModified });
    const deps = globalThis.__lib.deps(true);
    const pending = await globalThis.__lib.listPendingUploads(deps.resume);
    if (pending.length !== 1 || pending[0].files[0].name !== name) return { error: "pending uploads: " + JSON.stringify(pending) };
    const { shareUrl } = await globalThis.__lib.resumeUpload(pending[0].id, [file], deps);
    if ((await globalThis.__lib.listPendingUploads(deps.resume)).length !== 0) return { error: "the record outlived its upload" };
    return { shareUrl };
  }, spec);
  if (res.error) fail("resume: " + res.error);
  // tusd keeps what arrived of a request cut off mid-body, so the offset can
  // lie past the first chunk; it must not be back at the start.
  if (!(sent[0] >= 1024 * 1024)) fail("resume: the second tab started at offset " + sent[0]);
  console.log("resume: the second tab went on at offset " + sent[0]);
  await lib.libCtx.close();

  const dl = await open("resume dl", res.shareUrl);
  await dl.getByText("resumed.bin", { exact: true }).waitFor(WAIT);
  const [download] = await Promise.all([dl.waitForEvent("download", WAIT), dl.locator("[data-cp=download-all]").click()]);
  if (!readFileSync(await download.path()).equals(data)) fail("resume: the resumed share does not download as the original");
  console.log("resume: an upload cut off with its tab went on in a new tab and downloads intact ✓");
}

// Starts an upload on the start page and closes its tab once the server has
// made the upload, before a byte of it arrived.
async function cutOffUpload(file, label) {
  const page = await open(label, BASE);
  let created = false;
  await page.route("**/files/**", (route) => {
    if (route.request().method() === "PATCH") return;
    return route.continue();
  });
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url().includes("/files") && r.status() === 201) created = true;
  });
  await page.setInputFiles('input[type="file"]', file);
  await page.locator("[data-cp=upload]").click();
  const deadline = Date.now() + 60_000;
  while (!created && Date.now() < deadline) await page.waitForTimeout(100);
  if (!created) fail(`${label}: the upload never started`);
  // The record takes the upload's URL right after the create.
  await page.waitForTimeout(1000);
  await page.close();
}

// An upload cut off with its tab shows on the start page of a new tab. Discard
// forgets it, and picking the same file again finishes it.
async function resumeDialogOnTheStartPage() {
  // A file on disk, so picking it again brings the same modification time.
  const data = randomBytes(512 * 1024);
  const file = join(mkdtempSync(join(tmpdir(), "cp-e2e-")), "dialog.bin");
  writeFileSync(file, data);

  await cutOffUpload(file, "resume dialog cut 1");
  const start = await open("resume dialog discard", BASE);
  const card = start.locator("[data-cp=resume]");
  await card.getByText("dialog.bin", { exact: true }).waitFor(WAIT);
  await card.locator("[data-cp=resume-discard]").click();
  await card.waitFor({ state: "detached", ...WAIT });
  await start.close();
  const again = await open("resume dialog after discard", BASE);
  await again.locator("[data-cp=choose]").waitFor(WAIT);
  await again.waitForTimeout(1000);
  if (await again.locator("[data-cp=resume]").count()) fail("resume dialog: a discarded upload came back");
  await again.close();
  console.log("resume dialog: an unfinished upload is listed and can be discarded ✓");

  await cutOffUpload(file, "resume dialog cut 2");
  const page = await open("resume dialog pick", BASE);
  await page.locator("[data-cp=resume]").getByText("dialog.bin", { exact: true }).waitFor(WAIT);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", WAIT), page.locator("[data-cp=resume-pick]").click()]);
  await chooser.setFiles(file);
  const shareUrl = await waitForLink(page, "/d/");
  if ((await page.locator("[data-cp=resume]").count()) !== 0) fail("resume dialog: the finished upload is still listed");
  const dl = await open("resume dialog dl", shareUrl);
  await dl.getByText("dialog.bin", { exact: true }).waitFor(WAIT);
  const [download] = await Promise.all([dl.waitForEvent("download", WAIT), dl.locator("[data-cp=download-all]").click()]);
  if (!readFileSync(await download.path()).equals(data)) fail("resume dialog: the resumed share does not match");
  console.log("resume dialog: picking the same file again finished the upload ✓");
}

// A note written on /note and read on the share page, once in link mode and
// once with a password and a single download. The page must show markup in a
// note as text and never run it.
async function noteRoundTrips() {
  const cases = [
    { label: "note", password: "", once: false },
    { label: "note with password", password: "correct horse battery", once: true },
  ];
  for (const c of cases) {
    const note = `<img src=x onerror="window.__pwned=1">\n${c.label}: the gate code is 4711 🏰`;
    const up = await open(`${c.label} up`, `${BASE}/note`);
    await up.locator("textarea").fill(note);
    if (c.once) await up.locator("[data-cp=limit-once]").click();
    if (c.password) {
      await up.locator("[data-cp=lock]").click();
      await up.locator('input[type="password"]').fill(c.password);
    }
    await up.locator("[data-cp=share-note]").click();
    const shareUrl = await waitForLink(up, "/d/");

    const dl = await open(`${c.label} dl`, shareUrl);
    if (c.password) {
      await dl.locator('input[type="password"]').fill(c.password);
      await dl.locator("[data-cp=unlock]").click();
    }
    await dl.locator("[data-cp=show-note]").click();
    await dl.locator("pre").waitFor(WAIT);
    const shown = await dl.evaluate(() => ({
      text: document.querySelector("pre")?.textContent ?? "",
      images: document.querySelectorAll("pre img").length,
      pwned: globalThis.__pwned === 1,
    }));
    if (shown.text !== note) fail(`${c.label}: shown ${JSON.stringify(shown.text)}`);
    if (shown.images !== 0 || shown.pwned) fail(`${c.label}: the note was rendered as HTML`);

    const slug = slugOf(shareUrl);
    // The server burns a used-up share once it has sent the last byte, which
    // can land just after the page has shown the note.
    let m = await meta(dl, slug);
    for (let i = 0; c.once && m.status() !== 404 && i < 50; i++) {
      await dl.waitForTimeout(100);
      m = await meta(dl, slug);
    }
    if (c.once && m.status() !== 404) fail(`${c.label}: a once-only note survived its reading`);
    if (!c.once && (await m.json()).format !== 4) fail(`${c.label}: not a format 4 share`);
    console.log(`${c.label}: written, read as text, never as HTML ✓`);
  }
}

// A file request opened on /request, filled on the request link's page and
// collected on the collect link's page. The request link alone must not list
// anything.
async function requestRoundTrip() {
  const files = [
    { name: "asked-for.bin", mimeType: "application/octet-stream", buffer: randomBytes(150 * 1024) },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("a second file") },
  ];
  const req = await open("request", `${BASE}/request`);
  await req.getByText(/anyone with the request link can upload/i).waitFor(WAIT);
  await req.locator("[data-cp=create-request]").click();
  const requestUrl = await waitForLink(req, "/r/");
  const collectUrl = await waitForLink(req, "/c/");
  if (!requestUrl.includes("#p=") || !collectUrl.includes("#c=")) fail("request links without their keys");
  const slug = slugOf(requestUrl);
  if (slugOf(collectUrl) !== slug) fail("the two links name different requests");

  const send = await open("send", requestUrl);
  await send.locator("[data-cp=choose]").waitFor(WAIT);
  await send.setInputFiles('input[type="file"]', files);
  await send.locator("[data-cp=send]").click();
  await send.locator("[data-cp=send-end]").getByText(/^sent$/i).waitFor(WAIT);

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

  const col = await open("collect", collectUrl);
  const downloads = [];
  col.on("download", (d) => downloads.push(d));
  for (const f of files) await col.getByText(f.name, { exact: true }).waitFor(WAIT);
  await col.locator("[data-cp=download]").click();
  await downloadsOf(col, downloads, 1, "request");
  const entries = unzipped(await downloads[0].path());
  if (entries.length !== files.length) fail(`request: the ZIP holds ${entries.length} files`);
  for (const [i, e] of entries.entries()) {
    if (e.name !== files[i].name || !e.data.equals(files[i].buffer)) fail(`request: ${e.name} does not match ${files[i].name}`);
  }

  await col.locator("[data-cp=close-request]").click();
  await col.getByRole("dialog").getByRole("button", { name: /close request/i }).click();
  await col.locator("[data-cp=collect-end]").getByText(/request closed/i).first().waitFor({ timeout: 30_000 });
  // The closed request answers 404, which the browser logs, so only page
  // errors count here.
  const after = await ctx.newPage();
  after.on("pageerror", (e) => errors.push("collect after close: " + e));
  await after.goto(collectUrl, { waitUntil: "domcontentloaded", ...WAIT });
  await after.getByText(/has expired, or the link is incomplete/i).waitFor({ timeout: 30_000 });
  console.log("request: sent through the request link, collected and closed through the collect link ✓");
}

// A once-only share shows its file name from the uncounted header and is
// still unspent afterwards.
async function limitedShareListsBeforeDownload() {
  const { shareUrl } = await share("limited", { name: "once-only.bin", mimeType: "application/octet-stream", buffer: randomBytes(4096) }, { once: true });
  const dl = await open("limited dl", shareUrl);
  await dl.getByText("once-only.bin", { exact: true }).waitFor(WAIT);
  const m = await (await meta(dl, slugOf(shareUrl))).json();
  if (m.downloadsLeft !== 1) fail("listing spent the share: downloadsLeft " + m.downloadsLeft);
  console.log("limited share: name shown before the download, nothing spent ✓");
}

// The ways in and out of the start page that need no upload: a note or a
// request opening under the castle and Back closing it, text pasted outside a
// field, and files dropped away from the castle.
async function startPageShortcuts() {
  const page = await open("shortcuts", BASE);
  // Tall enough that the start page stands centred with room above the castle.
  await page.setViewportSize({ width: 1280, height: 1100 });
  const castle = page.locator(".cp-mark");
  const settled = async () => {
    await page.waitForTimeout(1000);
    return castle.boundingBox();
  };
  const home = await settled();
  for (const [to, path] of [["to-note", "/note"], ["to-request", "/request"]]) {
    await page.locator(`[data-cp=${to}]`).click();
    await page.waitForURL(`${BASE}${path}`, WAIT);
    await page.locator(`[data-cp=panel-${path.slice(1)}]`).waitFor(WAIT);
    const open = await settled();
    if (Math.round(open.width) !== Math.round(home.width) || Math.round(open.height) !== Math.round(home.height)) fail(`${path}: the castle changed its size`);
    if (open.y >= home.y) fail(`${path}: the castle did not move up`);
    if (await page.locator(".cp-claim, [data-cp=choose], .cp-trust").count()) fail(`${path}: the start page texts stayed under the castle`);
    await page.locator("[data-cp=back]").click();
    await page.waitForURL(`${BASE}/`, WAIT);
    await page.locator(".cp-claim").waitFor(WAIT);
  }

  const text = "pasted on the start page\nsecond line";
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await page.waitForURL(`${BASE}/note`, WAIT);
  if ((await page.locator("textarea").inputValue()) !== text) fail("pasted text did not open the note page with it");
  await page.locator("[data-cp=back]").click();
  await page.waitForURL(`${BASE}/`, WAIT);
  if (await page.locator("[data-cp=share-note]").count()) fail("the note page is still showing");

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["dropped"], "dropped-anywhere.txt", { type: "text/plain" }));
    const at = document.querySelector(".cp-trust");
    at.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    at.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.getByText("dropped-anywhere.txt", { exact: true }).waitFor(WAIT);
  if (await page.locator("[data-cp=dropzone]").count()) fail("the drop zone stayed after the drop");
  await page.close();
  console.log("start page: a note and a request open under the castle, Back returns home, pasted text opens a note, a drop anywhere adds files ✓");
}

// Options and the finished link lead out from the same spot as every other
// page: Back on the options, Leave on the link, both back to the start page.
async function wayOutSitsInTheHead() {
  const page = await open("way out", `${BASE}/note`);
  const spot = async (cp) => {
    const head = page.locator(`.cp-head [data-cp=${cp}]`);
    await head.waitFor(WAIT);
    if ((await page.locator(`[data-cp=${cp}]`).count()) !== 1) fail(`${cp}: a second ${cp} button outside the head`);
    const box = await head.boundingBox();
    return `${Math.round(box.x)},${Math.round(box.y)}`;
  };
  const noteBack = await spot("back");
  await page.locator("[data-cp=back]").click();
  await page.waitForURL(`${BASE}/`, WAIT);

  await page.setInputFiles('input[type="file"]', { name: "way-out.txt", mimeType: "text/plain", buffer: Buffer.from("way out") });
  await page.locator("[data-cp=upload]").waitFor(WAIT);
  if ((await spot("back")) !== noteBack) fail("options: Back is not where it is on the note page");
  await page.locator("[data-cp=back]").click();
  await page.locator("[data-cp=choose]").waitFor(WAIT);
  if (await page.getByText("way-out.txt", { exact: true }).count()) fail("options: Back kept the file");

  await page.setInputFiles('input[type="file"]', { name: "way-out.txt", mimeType: "text/plain", buffer: Buffer.from("way out") });
  await page.locator("[data-cp=upload]").click();
  await waitForLink(page, "/d/");
  if ((await spot("leave")) !== noteBack) fail("link: Leave is not where Back is on the note page");
  await page.locator("[data-cp=leave]").click();
  await page.locator("[data-cp=choose]").waitFor(WAIT);
  if (await page.locator("[data-cp=leave]").count()) fail("link: Leave stayed on the start page");
  await page.close();
  console.log("way out: Back on the options and Leave on the link sit where Back sits everywhere ✓");
}

// Every settings tile opens inside Settings, and none of them opens a window.
// Back leads to the page Settings was opened from.
async function infoTabStaysInSettings() {
  const page = await open("settings", `${BASE}/note`);
  await page.locator("[data-cp=settings]").click();
  await page.waitForURL(`${BASE}/settings/general`, WAIT);
  const before = ctx.pages().length;
  await page.locator("[data-sel-id=info]").click();
  await page.waitForURL(`${BASE}/settings/info`, WAIT);
  await page.getByText("CastleParcel", { exact: true }).first().waitFor(WAIT);
  await page.waitForTimeout(500);
  if (ctx.pages().length !== before) fail(`the Info tab opened ${ctx.pages().length - before} more page(s)`);
  await page.locator("[data-cp=back]").click();
  await page.waitForURL(`${BASE}/note`, WAIT);
  await page.close();
  console.log("settings: the Info tab opens in place, Back leads where Settings was opened from ✓");
}

// The castle loader plays while a transfer runs. A slow network keeps the
// upload and the download on screen, and a CSP refusal of the WebAssembly the
// main script carries would land in the console errors the run fails on.
async function castleLoaderPlays() {
  const throttle = async (page, bytesPerSecond) => {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: bytesPerSecond, uploadThroughput: bytesPerSecond });
    return () => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  };
  const drawn = async (page, mode) => {
    await page.waitForFunction((m) => {
      const canvas = document.querySelector(`.castle[data-mode="${m}"] canvas`);
      if (!canvas || canvas.width === 0) return false;
      const copy = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
      const g = copy.getContext("2d");
      g.drawImage(canvas, 0, 0);
      const alpha = g.getImageData(0, 0, copy.width, copy.height).data;
      for (let i = 3; i < alpha.length; i += 4) if (alpha[i] > 0) return true;
      return false;
    }, mode, WAIT);
    const bar = await page.locator(".castle [role=progressbar]").getAttribute("aria-valuenow");
    if (bar === null) fail(`castle ${mode}: the progress bar has no value`);
  };

  const payload = randomBytes(2 * 1024 * 1024);
  const up = await open("castle up", BASE);
  await up.setInputFiles('input[type="file"]', { name: "castle.bin", mimeType: "application/octet-stream", buffer: payload });
  const fastUp = await throttle(up, 256 * 1024);
  await up.locator("[data-cp=upload]").click();
  await drawn(up, "upload");
  await fastUp();
  const shareUrl = await waitForLink(up, "/d/");

  const dl = await open("castle dl", shareUrl);
  await dl.getByText("castle.bin", { exact: true }).waitFor(WAIT);
  const fastDown = await throttle(dl, 256 * 1024);
  const saved = dl.waitForEvent("download", WAIT);
  await dl.locator("[data-cp=download-all]").click();
  await drawn(dl, "download");
  await fastDown();
  if (!readFileSync(await (await saved).path()).equals(payload)) fail("castle: the download does not match the upload");
  await up.close();
  await dl.close();
  console.log("castle loader: drawn on its canvas during the upload and the download ✓");
}
