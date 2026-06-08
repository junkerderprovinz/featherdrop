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
  assert.equal(mimeFromName("doc.pdf"), "application/pdf");
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
