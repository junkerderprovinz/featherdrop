import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError, retryAfterSeconds } from "../lib/e2e/http-error";
import { fetchShareHeader } from "../lib/e2e/share-listing";
import { DownloadInProgressError, fetchShareBlob } from "../lib/e2e/download-flow";
import { revokeShare } from "../lib/e2e/manage-link";

const answer = (status: number, headers: Record<string, string> = {}) =>
  (async () => new Response("{}", { status, headers })) as unknown as typeof fetch;

test("a refused header read carries the status and the wait the server asks for", async () => {
  const err = await fetchShareHeader("slug", "v", answer(429, { "Retry-After": "90" })).catch((e: unknown) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 90);
});

test("a wrong verifier on the header read is a 401 without a wait", async () => {
  const err = await fetchShareHeader("slug", "v", answer(401)).catch((e: unknown) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 401);
  assert.equal(err.retryAfter, null);
});

test("a refused download carries its status and wait", async () => {
  const err = await fetchShareBlob("slug", answer(429, { "Retry-After": "5" }))("v").catch((e: unknown) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 5);
  const missing = await fetchShareBlob("slug", answer(404))("v").catch((e: unknown) => e);
  assert.ok(missing instanceof HttpError && missing.status === 404);
});

test("a download of a one-time share already running stays its own error", async () => {
  await assert.rejects(fetchShareBlob("slug", answer(409))("v"), DownloadInProgressError);
});

test("a refused revoke carries its status", async () => {
  const err = await revokeShare("slug", "t", answer(429, { "Retry-After": "3" })).catch((e: unknown) => e);
  assert.ok(err instanceof HttpError && err.status === 429 && err.retryAfter === 3);
});

test("Retry-After is read as seconds or as a date, and ignored when it is neither", () => {
  assert.equal(retryAfterSeconds("120"), 120);
  assert.equal(retryAfterSeconds(new Date(61_000).toUTCString(), 1_000), 60);
  assert.equal(retryAfterSeconds("soon"), null);
  assert.equal(retryAfterSeconds(null), null);
});
