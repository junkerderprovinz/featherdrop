import { test } from "node:test";
import assert from "node:assert/strict";
import { isUploadComplete } from "../lib/upload";

// The tus file-store sidecar keeps `offset` frozen at 0 (it tracks progress via
// the live file size, not the sidecar), so completeness must be judged from the
// ACTUAL bytes on disk vs the declared total — never the sidecar offset.

test("a fully received upload is complete (actual == declared)", () => {
  // The regression: a complete 3100-byte upload must NOT be rejected.
  assert.equal(isUploadComplete(3100, 3100), true);
});

test("a partially received upload is incomplete (actual < declared)", () => {
  assert.equal(isUploadComplete(1000, 3100), false);
});

test("more bytes than declared counts as complete (never block)", () => {
  assert.equal(isUploadComplete(3200, 3100), true);
});

test("an unknown declared length (deferred) is treated as complete", () => {
  assert.equal(isUploadComplete(3100, undefined), true);
  assert.equal(isUploadComplete(3100, null), true);
});

test("an empty upload (0 of 0) is complete", () => {
  assert.equal(isUploadComplete(0, 0), true);
});

test("zero bytes received of a known non-zero total is incomplete", () => {
  assert.equal(isUploadComplete(0, 3100), false);
});
