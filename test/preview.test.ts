import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreviewableMime, previewKind } from "../lib/preview";

// Only inert types may be rendered inline from our own origin. SVG and HTML can
// carry scripts (stored-XSS vector), so they must NOT be previewable; the server
// enforces this allowlist because the inline GET is attacker-reachable directly.

test("inert raster images and PDF are previewable", () => {
  for (const m of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "application/pdf",
  ]) {
    assert.equal(isPreviewableMime(m), true, m);
  }
});

test("inert video containers are previewable", () => {
  for (const m of ["video/mp4", "video/webm", "video/ogg"]) {
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
  assert.equal(isPreviewableMime("VIDEO/MP4"), true);
});

test("previewKind maps each allowlisted type to its render kind", () => {
  assert.equal(previewKind("image/png"), "image");
  assert.equal(previewKind("image/jpeg"), "image");
  assert.equal(previewKind("image/gif"), "image");
  assert.equal(previewKind("image/webp"), "image");
  assert.equal(previewKind("image/avif"), "image");
  assert.equal(previewKind("video/mp4"), "video");
  assert.equal(previewKind("video/webm"), "video");
  assert.equal(previewKind("video/ogg"), "video");
  assert.equal(previewKind("application/pdf"), "pdf");
});

test("previewKind returns null for non-previewable / unknown types", () => {
  assert.equal(previewKind(null), null);
  assert.equal(previewKind(undefined), null);
  assert.equal(previewKind(""), null);
  assert.equal(previewKind("application/octet-stream"), null);
  assert.equal(previewKind("image/svg+xml"), null);
  assert.equal(previewKind("text/html"), null);
  assert.equal(previewKind("video/quicktime"), null);
});

test("previewKind is case-insensitive and parameter-tolerant", () => {
  assert.equal(previewKind("VIDEO/WEBM"), "video");
  assert.equal(previewKind("video/mp4; codecs=avc1"), "video");
  assert.equal(previewKind("  Application/PDF  "), "pdf");
});
