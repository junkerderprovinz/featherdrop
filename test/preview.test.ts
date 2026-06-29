import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPreviewableMime,
  isServerInlineMime,
  previewKind,
} from "../lib/preview";

// Only INERTLY-renderable types may be previewed. The CLIENT decrypts to a blob:
// URL rendered in an inert element (<img>/<video>/<audio>/<embed>/<pre>), so it
// can also safely preview SVG via <img> (no scripts run there). The SERVER inline
// route is rendered as a top-level document, so it uses the STRICTER
// isServerInlineMime, which excludes SVG. HTML and unknown types are never
// previewable on either surface.

test("inert raster images and PDF are previewable", () => {
  for (const m of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/apng",
    "application/pdf",
  ]) {
    assert.equal(isPreviewableMime(m), true, m);
  }
});

test("inert video containers are previewable", () => {
  for (const m of [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/x-m4v",
    "video/x-matroska",
    "video/mkv",
  ]) {
    assert.equal(isPreviewableMime(m), true, m);
  }
});

test("audio containers are previewable", () => {
  for (const m of [
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/webm",
    "audio/opus",
  ]) {
    assert.equal(isPreviewableMime(m), true, m);
  }
});

test("text/code types are previewable", () => {
  for (const m of [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
    "application/x-yaml",
    "text/yaml",
  ]) {
    assert.equal(isPreviewableMime(m), true, m);
  }
});

test("SVG is client-previewable ONLY because we render it via <img> (no scripts)", () => {
  // image/svg+xml now maps to the "image" kind — but this is SAFE only because
  // PreviewArea renders it via an inert <img>. It is documented here so a future
  // change that adds an <embed>/<iframe>/inline SVG path is caught as a regression.
  assert.equal(previewKind("image/svg+xml"), "image");
  assert.equal(isPreviewableMime("image/svg+xml"), true);
  assert.equal(previewKind("image/svg+xml; charset=utf-8"), "image");
});

test("HTML-ish and unknown types are NOT previewable (XSS vectors / unknown)", () => {
  for (const m of [
    "text/html",
    "application/xhtml+xml",
    "application/octet-stream",
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
  assert.equal(isPreviewableMime("AUDIO/MPEG"), true);
  assert.equal(isPreviewableMime("Text/Plain"), true);
});

test("previewKind maps each allowlisted type to its render kind", () => {
  // image (raster + svg)
  for (const m of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/apng",
    "image/svg+xml",
  ]) {
    assert.equal(previewKind(m), "image", m);
  }
  // video
  for (const m of [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/x-m4v",
    "video/x-matroska",
    "video/mkv",
  ]) {
    assert.equal(previewKind(m), "video", m);
  }
  // audio
  for (const m of [
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/webm",
    "audio/opus",
  ]) {
    assert.equal(previewKind(m), "audio", m);
  }
  // text
  for (const m of [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
    "application/x-yaml",
    "text/yaml",
  ]) {
    assert.equal(previewKind(m), "text", m);
  }
  assert.equal(previewKind("application/pdf"), "pdf");
});

test("previewKind returns null for non-previewable / unknown types", () => {
  assert.equal(previewKind(null), null);
  assert.equal(previewKind(undefined), null);
  assert.equal(previewKind(""), null);
  assert.equal(previewKind("application/octet-stream"), null);
  assert.equal(previewKind("text/html"), null);
  assert.equal(previewKind("application/xhtml+xml"), null);
});

test("previewKind is case-insensitive and parameter-tolerant", () => {
  assert.equal(previewKind("VIDEO/WEBM"), "video");
  assert.equal(previewKind("video/mp4; codecs=avc1"), "video");
  assert.equal(previewKind("  Application/PDF  "), "pdf");
  assert.equal(previewKind("AUDIO/OPUS"), "audio");
  assert.equal(previewKind("Application/JSON; charset=utf-8"), "text");
});

// ---------------------------------------------------------------------------
// Server inline gate (stricter): SVG must NEVER be served inline by the server.
// ---------------------------------------------------------------------------

test("isServerInlineMime excludes SVG even though it is client-previewable", () => {
  // The single most important difference from isPreviewableMime: an inline server
  // response is a top-level document, and SVG can carry <script> = stored XSS.
  assert.equal(isPreviewableMime("image/svg+xml"), true);
  assert.equal(isServerInlineMime("image/svg+xml"), false);
  assert.equal(isServerInlineMime("image/svg+xml; charset=utf-8"), false);
});

test("isServerInlineMime allows the inert non-SVG previewable types", () => {
  for (const m of [
    "image/png",
    "image/bmp",
    "image/apng",
    "video/mp4",
    "video/quicktime",
    "audio/mpeg",
    "text/plain",
    "application/pdf",
  ]) {
    assert.equal(isServerInlineMime(m), true, m);
  }
});

test("isServerInlineMime rejects HTML / unknown / null", () => {
  for (const m of [
    "text/html",
    "application/xhtml+xml",
    "application/octet-stream",
    "",
  ]) {
    assert.equal(isServerInlineMime(m), false, m);
  }
  assert.equal(isServerInlineMime(null), false);
  assert.equal(isServerInlineMime(undefined), false);
});
