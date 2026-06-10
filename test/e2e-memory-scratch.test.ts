import { test } from "node:test";
import assert from "node:assert/strict";
import { writeMemoryScratch, canUseOpfs } from "../lib/e2e/opfs-scratch";

// Node exposes a global `navigator` (with userAgent) but no `navigator.storage`,
// which mirrors a browser on a non-secure (HTTP) context — exactly the case the
// in-memory fallback exists for.
test("canUseOpfs() is false without navigator.storage (HTTP / Node)", () => {
  assert.equal(canUseOpfs(), false);
});

test("writeMemoryScratch collects an async iterable into a byte-identical File", async () => {
  async function* gen() {
    yield new Uint8Array([1, 2, 3]);
    yield new Uint8Array([4, 5]);
  }
  const { file, cleanup } = await writeMemoryScratch(gen());
  assert.ok(file instanceof File);
  assert.equal(file.size, 5);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  await cleanup(); // no-op, must not throw
});
