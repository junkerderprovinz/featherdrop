# featherdrop Zero-Knowledge — Phase 2: Blob Layout + OPFS Scratch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn a plaintext `File` + key + metadata into a ready-to-upload **encrypted OPFS scratch file** in the zero-knowledge blob layout, with cleanup — the seekable source the resumable tus upload (Phase 4) reads from.

**Architecture:** Two focused modules. `lib/e2e/blob-layout.ts` is pure stream logic (varint-framed `enc_meta` prepended to the encrypted content stream) — Node-testable. `lib/e2e/opfs-scratch.ts` does the browser-only OPFS I/O (stream a blob to an OPFS file, hand back a sliceable `File` + a cleanup, sweep stale scratch files) — Playwright-tested.

**Tech Stack:** TypeScript, `lib/e2e/crypto.ts` (Phase 1), OPFS (`navigator.storage.getDirectory`), node:test + tsx (pure tests), Playwright (browser tests).

**Spike result (confirmed 2026-06-10, real Chromium):** `{hasOPFS:true, size:2097152, isBlob:true, sliceReadOk:true, reopenOk:true}` — OPFS write → `getFile()` → `Blob` → `slice()` reads back correct bytes; a fresh `getFile()` handle has the same size (resume-after-reload foundation). The "encrypt → OPFS scratch → resumable tus" approach is sound in Chromium. Safari OPFS + the live tus resume remain real-device manual tests (spec §13).

**Spec:** `docs/superpowers/specs/2026-06-09-featherdrop-zero-knowledge-design.md` §4 (blob layout), §5.2 (opfs scratch).

---

## File Structure

- **Create** `lib/e2e/blob-layout.ts` — varint codec + `assembleBlob` / `readBlobMeta` (pure).
- **Create** `test/e2e-blob-layout.test.ts` — node:test unit tests.
- **Create** `lib/e2e/opfs-scratch.ts` — `writeScratch` + `sweepStaleScratch` (browser).
- **Create** `test/browser/opfs-scratch.spec.mjs` + a `test:browser` npm script — Playwright.

Blob layout (spec §4): `[ varint(enc_meta.length) ][ enc_meta ][ secretstream header ][ frames… ]`.

---

## Task 1: Blob layout — varint framing (pure, Node-testable)

**Files:**
- Create: `lib/e2e/blob-layout.ts`
- Test: `test/e2e-blob-layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e-blob-layout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeVarint,
  decodeVarint,
  assembleBlob,
  readBlobMeta,
} from "../lib/e2e/blob-layout";

async function* one(b: Uint8Array) {
  yield b;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let len = 0;
  for await (const p of it) {
    parts.push(p);
    len += p.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

for (const n of [0, 1, 127, 128, 300, 16384, 1_000_000]) {
  test(`varint round-trips ${n}`, () => {
    const enc = encodeVarint(n);
    const { value, bytesRead } = decodeVarint(enc, 0);
    assert.equal(value, n);
    assert.equal(bytesRead, enc.length);
  });
}

test("assembleBlob + readBlobMeta round-trip (meta + content)", async () => {
  const meta = new Uint8Array([1, 2, 3, 4, 5]);
  const content = new Uint8Array(200).map((_, i) => i % 251);
  const blob = await collect(assembleBlob(meta, one(content)));
  const { encMeta, content: rest } = await readBlobMeta(one(blob));
  assert.deepEqual(encMeta, meta);
  assert.deepEqual(await collect(rest), content);
});

test("readBlobMeta works when input arrives in tiny pieces", async () => {
  const meta = new Uint8Array(300).map((_, i) => (i * 3) % 251);
  const content = new Uint8Array(50).fill(9);
  const blob = await collect(assembleBlob(meta, one(content)));
  async function* drip() {
    for (let i = 0; i < blob.length; i += 7) yield blob.subarray(i, i + 7);
  }
  const { encMeta, content: rest } = await readBlobMeta(drip());
  assert.deepEqual(encMeta, meta);
  assert.deepEqual(await collect(rest), content);
});

test("readBlobMeta throws on truncated header", async () => {
  await assert.rejects(() => readBlobMeta(one(new Uint8Array(0))));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/e2e-blob-layout.test.ts`
Expected: FAIL — `Cannot find module '../lib/e2e/blob-layout'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/e2e/blob-layout.ts

/** Unsigned LEB128 varint encode. */
export function encodeVarint(n: number): Uint8Array {
  if (n < 0 || !Number.isInteger(n)) throw new Error("varint: non-negative int required");
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return new Uint8Array(out);
}

/** Unsigned LEB128 varint decode from `bytes` at `offset`. */
export function decodeVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 1;
  let i = offset;
  for (; i < bytes.length; i++) {
    const byte = bytes[i];
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, bytesRead: i - offset + 1 };
    shift *= 128;
  }
  throw new Error("varint: truncated");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Prepend [varint(metaLen)][enc_meta] to the encrypted content stream. */
export async function* assembleBlob(
  encMeta: Uint8Array,
  content: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield concat(encodeVarint(encMeta.length), encMeta);
  for await (const c of content) yield c;
}

/** Peel off enc_meta from a blob stream; return it + the remaining content stream. */
export async function readBlobMeta(
  source: AsyncIterable<Uint8Array>,
): Promise<{ encMeta: Uint8Array; content: AsyncGenerator<Uint8Array> }> {
  const iter = source[Symbol.asyncIterator]();
  let buf = new Uint8Array(0);

  async function pullMore(): Promise<boolean> {
    const r = await iter.next();
    if (r.done) return false;
    buf = concat(buf, r.value);
    return true;
  }

  // Ensure enough bytes to decode the length varint.
  let metaLen: number;
  let headerLen: number;
  for (;;) {
    try {
      const d = decodeVarint(buf, 0);
      metaLen = d.value;
      headerLen = d.bytesRead;
      break;
    } catch {
      if (!(await pullMore())) throw new Error("blob: truncated (no length)");
    }
  }
  // Ensure the full enc_meta is buffered.
  while (buf.length < headerLen + metaLen) {
    if (!(await pullMore())) throw new Error("blob: truncated (incomplete meta)");
  }
  const encMeta = buf.subarray(headerLen, headerLen + metaLen);
  const leftover = buf.subarray(headerLen + metaLen);

  async function* content(): AsyncGenerator<Uint8Array> {
    if (leftover.length > 0) yield leftover;
    for (;;) {
      const r = await iter.next();
      if (r.done) return;
      yield r.value;
    }
  }
  return { encMeta, content: content() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/e2e-blob-layout.test.ts`
Expected: PASS (all varint sizes + round-trips + drip + truncation).

- [ ] **Step 5: Commit**

```bash
git add lib/e2e/blob-layout.ts test/e2e-blob-layout.test.ts
git commit -m "feat(e2e): zero-knowledge blob layout (varint-framed enc_meta + content)"
```

---

## Task 2: OPFS scratch module (browser) + Playwright harness

> **Note:** This task introduces featherdrop's first browser-test harness (Playwright; devDep already added in `a6f93b0`). It is browser-bound and benefits from being built with the harness in front of you. Build order within the task is below; the implementer should confirm the Playwright wiring early.

**Files:**
- Create: `lib/e2e/opfs-scratch.ts`
- Create: `test/browser/opfs-scratch.spec.mjs`
- Modify: `package.json` (add `"test:browser"` script)

**Module interface (`lib/e2e/opfs-scratch.ts`):**
```ts
// Streams a blob into a uniquely-named OPFS file and returns a sliceable File
// + a cleanup. Scratch names embed a timestamp so sweepStaleScratch can GC
// leftovers from aborted uploads. Browser-only (navigator.storage.getDirectory).
export async function writeScratch(
  blob: AsyncIterable<Uint8Array>,
): Promise<{ file: File; cleanup: () => Promise<void> }>;

export async function sweepStaleScratch(maxAgeMs: number): Promise<void>;
```
- `writeScratch`: `getDirectory()` → `getFileHandle("fd-scratch-<ts>-<rand>.bin", {create:true})` → `createWritable()` → for-await write each blob chunk → `close()` → `getFile()`; `cleanup` = `root.removeEntry(name)`.
- `sweepStaleScratch`: iterate `root.values()`, parse the `<ts>` from `fd-scratch-` names, `removeEntry` those older than `maxAgeMs`.

**Test (`test/browser/opfs-scratch.spec.mjs`, Playwright):** esbuild-bundle `lib/e2e/opfs-scratch.ts` to an IIFE, serve a localhost page, `page.addScriptTag`, then in `page.evaluate`: `writeScratch` a 2 MiB async-iterable → assert `file.size === 2*1024*1024`, slice-read a chunk back correctly, `cleanup()` removes it; `sweepStaleScratch(0)` clears a planted stale file. Add `"test:browser": "node test/browser/run.mjs"` (a tiny runner that esbuilds + launches Playwright), kept separate from `npm test` (needs a browser).

- [ ] **Step 1–5:** TDD as above — write the Playwright spec first (fails: no module), implement `opfs-scratch.ts`, get the browser test green, wire `test:browser`, commit. (Full step-by-step code to be finalized at execution time with the Playwright harness in front of you — the module interface + test assertions above are fixed.)

---

## Task 3: Gate

- [ ] Run `npm test` (pure suite incl. blob-layout) + `npm run test:browser` (OPFS) + `npx tsc --noEmit` + `npm run lint` — all clean. Commit any fixes.

---

## Self-Review

- **Spec coverage:** blob layout §4 → Task 1 ✓; opfs scratch §5.2 + stale sweep (§13 risk) → Task 2 ✓.
- **Placeholder note:** Task 1 is fully specified (buildable now). Task 2's per-step code is intentionally deferred to execution because the Playwright/esbuild harness wiring is best finalized empirically — the module interface and test assertions are fixed, so it is not an open-ended placeholder.
- **Type consistency:** `assembleBlob`/`readBlobMeta`/`encodeVarint`/`decodeVarint` (Task 1) consumed by `writeScratch` (Task 2) and later the upload flow (Phase 4).

## Next phases
3. Service-worker streaming download. 4. Upload flow (wire crypto + blob-layout + opfs-scratch + tus + `#k=` link). 5. Download flow. 6. Client preview. 7. Server simplification + schema/migration. 8. Copy + v4 release.
