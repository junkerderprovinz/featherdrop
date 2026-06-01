import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreviewableMime } from "../lib/preview";

// Only inert types may be rendered inline from our own origin. SVG and HTML can
// carry scripts (stored-XSS vector), so they must NOT be previewable; the server
// enforces this allowlist because the inline GET is attacker-reachable directly.

test("inert raster images and PDF are previewable", () => {
  for (const m of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
  ]) {
    assert.equal(isPreviewableMime(m), true, m);
  }
});

test("SVG and HTML-ish types are NOT previewable (XSS vectors)", () => {
  for (const m of [
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "text/xml",
    "image/svg+xml; charset=utf-8",
  ]) {
    assert.equal(isPreviewableMime(m), false, m);
  }
});

test("null / unknown / generic types are not previewable", () => {
  assert.equal(isPreviewableMime(null), false);
  assert.equal(isPreviewableMime(undefined), false);
  assert.equal(isPreviewableMime(""), false);
  assert.equal(isPreviewableMime("application/octet-stream"), false);
});

test("matching is case-insensitive and ignores parameters", () => {
  assert.equal(isPreviewableMime("IMAGE/PNG"), true);
  assert.equal(isPreviewableMime("image/png; charset=utf-8"), true);
  assert.equal(isPreviewableMime("  application/pdf  "), true);
});
