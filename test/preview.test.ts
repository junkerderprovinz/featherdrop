import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPreviewableMime,
  isServerInlineMime,
  previewKind,
} from "../lib/preview";

// The client renders previews in inert elements and can show SVG through an
// <img>. A server inline response renders as a top-level document, so
// isServerInlineMime also excludes SVG. HTML and unknown types preview on
// neither.

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
    "video/x-msvideo",
    "video/avi",
    "video/mpeg",
    "video/3gpp",
    "video/x-ms-wmv",
    "video/x-flv",
    "video/mp2t",
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

test("SVG is client-previewable as an image, which renders through <img>", () => {
  // Safe only while PreviewArea renders the image kind through an inert <img>.
  assert.equal(previewKind("image/svg+xml"), "image");
  assert.equal(isPreviewableMime("image/svg+xml"), true);
  assert.equal(previewKind("image/svg+xml; charset=utf-8"), "image");
});

test("HTML-ish and unknown types are not previewable", () => {
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
    "video/x-msvideo",
    "video/avi",
    "video/mpeg",
    "video/3gpp",
    "video/x-ms-wmv",
    "video/x-flv",
    "video/mp2t",
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

test("isServerInlineMime excludes SVG even though it is client-previewable", () => {
  // As a top-level document an SVG can run scripts, which is stored XSS.
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
