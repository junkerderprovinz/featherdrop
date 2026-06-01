import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBranding, normalizeHex, accentTuple } from "../lib/branding";

// Custom branding for self-hosters: APP_NAME (wordmark + title), APP_LOGO (URL
// replacing the feather), ACCENT_COLOR (hex driving the primary palette). Each
// falls back to the default featherdrop branding when unset or invalid.

test("defaults when no env is set", () => {
  const b = resolveBranding({});
  assert.equal(b.appName, "featherdrop");
  assert.equal(b.logoUrl, null);
  assert.equal(b.accentColor, "#d4af37");
});

test("APP_NAME overrides the wordmark; blank falls back", () => {
  assert.equal(resolveBranding({ APP_NAME: "MyShare" }).appName, "MyShare");
  assert.equal(resolveBranding({ APP_NAME: "   " }).appName, "featherdrop");
});

test("APP_LOGO sets the logo url; blank -> null", () => {
  assert.equal(
    resolveBranding({ APP_LOGO: "https://x/logo.svg" }).logoUrl,
    "https://x/logo.svg",
  );
  assert.equal(resolveBranding({ APP_LOGO: "  " }).logoUrl, null);
});

test("ACCENT_COLOR takes a valid 6-digit hex (lowercased)", () => {
  assert.equal(resolveBranding({ ACCENT_COLOR: "#AABBCC" }).accentColor, "#aabbcc");
});

test("invalid ACCENT_COLOR falls back to the default gold", () => {
  assert.equal(resolveBranding({ ACCENT_COLOR: "red" }).accentColor, "#d4af37");
  assert.equal(resolveBranding({ ACCENT_COLOR: "#FFF" }).accentColor, "#d4af37");
  assert.equal(resolveBranding({ ACCENT_COLOR: "" }).accentColor, "#d4af37");
});

test("normalizeHex validates and lowercases", () => {
  assert.equal(normalizeHex("#123abc"), "#123abc");
  assert.equal(normalizeHex("#ABCDEF"), "#abcdef");
  assert.equal(normalizeHex("#GGGGGG"), null);
  assert.equal(normalizeHex("#fff"), null);
  assert.equal(normalizeHex(undefined), null);
});

test("accentTuple builds 10 valid hex shades, base in the middle", () => {
  const t = accentTuple("#d4af37");
  assert.equal(t.length, 10);
  for (const shade of t) assert.match(shade, /^#[0-9a-f]{6}$/);
  // step 6 is the base colour (Mantine's default filled shade)
  assert.equal(t[6], "#d4af37");
  // lighter steps come first, darker steps last
  assert.ok(t[0] > t[9], "step 0 (light) should be a larger hex than step 9 (dark)");
});
