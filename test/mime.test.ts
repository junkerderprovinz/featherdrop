import { test } from "node:test";
import assert from "node:assert/strict";
import { mimeFromName } from "../lib/mime";

// Extension fallback used when the uploader's browser sends no content type, so
// image/PDF previews still work. Must mirror the lib/preview.ts allowlist.
test("maps known previewable extensions (case-insensitive)", () => {
  assert.equal(mimeFromName("photo.png"), "image/png");
  assert.equal(mimeFromName("photo.PNG"), "image/png");
  assert.equal(mimeFromName("a.jpg"), "image/jpeg");
  assert.equal(mimeFromName("a.jpeg"), "image/jpeg");
  assert.equal(mimeFromName("a.gif"), "image/gif");
  assert.equal(mimeFromName("a.webp"), "image/webp");
  assert.equal(mimeFromName("a.avif"), "image/avif");
  assert.equal(mimeFromName("doc.pdf"), "application/pdf");
});

test("maps new image extensions", () => {
  assert.equal(mimeFromName("a.bmp"), "image/bmp");
  assert.equal(mimeFromName("a.ico"), "image/x-icon");
  assert.equal(mimeFromName("a.apng"), "image/apng");
  assert.equal(mimeFromName("a.svg"), "image/svg+xml");
  assert.equal(mimeFromName("a.SVG"), "image/svg+xml");
});

test("maps video extensions", () => {
  assert.equal(mimeFromName("a.mp4"), "video/mp4");
  assert.equal(mimeFromName("a.webm"), "video/webm");
  assert.equal(mimeFromName("a.ogv"), "video/ogg");
  assert.equal(mimeFromName("a.mov"), "video/quicktime");
  assert.equal(mimeFromName("a.m4v"), "video/x-m4v");
});

test("maps audio extensions", () => {
  assert.equal(mimeFromName("a.mp3"), "audio/mpeg");
  assert.equal(mimeFromName("a.m4a"), "audio/mp4");
  assert.equal(mimeFromName("a.aac"), "audio/aac");
  assert.equal(mimeFromName("a.oga"), "audio/ogg");
  assert.equal(mimeFromName("a.opus"), "audio/opus");
  assert.equal(mimeFromName("a.wav"), "audio/wav");
  assert.equal(mimeFromName("a.flac"), "audio/flac");
});

test("maps text/code extensions", () => {
  assert.equal(mimeFromName("a.txt"), "text/plain");
  assert.equal(mimeFromName("a.log"), "text/plain");
  assert.equal(mimeFromName("a.md"), "text/markdown");
  assert.equal(mimeFromName("a.markdown"), "text/markdown");
  assert.equal(mimeFromName("a.csv"), "text/csv");
  assert.equal(mimeFromName("a.json"), "application/json");
  assert.equal(mimeFromName("a.xml"), "application/xml");
  assert.equal(mimeFromName("a.yaml"), "application/x-yaml");
  assert.equal(mimeFromName("a.yml"), "application/x-yaml");
});

test("uses the last extension for dotted names", () => {
  assert.equal(mimeFromName("my.photo.final.png"), "image/png");
});

test("returns null for unknown or missing extensions", () => {
  assert.equal(mimeFromName("archive.zip"), null);
  assert.equal(mimeFromName("noext"), null);
  assert.equal(mimeFromName("trailing."), null);
  assert.equal(mimeFromName(""), null);
});
