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
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
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
  await dlPage.goto(shareUrl, { waitUntil: "domcontentloaded" });

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

  console.log("E2E PASSED — zero-knowledge upload→download round trip verified");
} catch (e) {
  fail(String(e));
} finally {
  await browser.close();
}
