# featherdrop Zero-Knowledge — Phase 1: Crypto Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `lib/e2e/crypto.ts` — the pure, browser-and-Node-runnable client-side encryption core for featherdrop's zero-knowledge model (no DOM, no network, fully unit-tested).

**Architecture:** A single focused module wrapping libsodium (WASM). It exposes: key generation + URL codec, streaming content encryption/decryption over `AsyncIterable<Uint8Array>` (so it drives both browser Web Streams and Node test arrays), encrypted file-metadata, and Argon2id password key-wrapping. Everything is symmetric AEAD; nothing is hand-rolled.

**Tech Stack:** TypeScript, `libsodium-wrappers` (XChaCha20-Poly1305 `secretstream`, `secretbox`, `crypto_pwhash`/Argon2id), node:test + tsx (existing featherdrop test runner).

**Scope note:** This is Phase 1 of 8 (see spec §14). It produces a complete, tested crypto module with no UI/server changes. Later phases (OPFS scratch, service-worker download, upload/download flows, client preview, server simplification + schema migration, copy/docs/release) get their own plans.

**Spec:** `docs/superpowers/specs/2026-06-09-featherdrop-zero-knowledge-design.md` §4.

---

## File Structure

- **Create** `lib/e2e/crypto.ts` — the crypto core (one responsibility: turn plaintext+key into ciphertext frames and back, plus key/meta/password helpers).
- **Create** `test/e2e-crypto.test.ts` — unit tests (node:test).
- **Modify** `package.json` / `package-lock.json` — add `libsodium-wrappers` (+ types).

Constants used throughout (read from libsodium *after* `sodium.ready`):
- `PT_CHUNK = 65536` (64 KiB plaintext chunk) — module constant.
- `HEADERBYTES = 24`, `ABYTES = 17` (secretstream), `NONCEBYTES = 24`, `KEYBYTES = 32`, `SALTBYTES = 16` — read at call time from `sodium`.
- `CIPHER_CHUNK = PT_CHUNK + ABYTES = 65553`.

---

## Task 0: Add libsodium dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the library + types**

Run:
```bash
npm install libsodium-wrappers@^0.7.15
npm install -D @types/libsodium-wrappers@^0.7.14
```
Expected: both added to `package.json`, `package-lock.json` updated.

- [ ] **Step 2: Verify it loads in the test runtime**

Run:
```bash
node --import tsx -e "import s from 'libsodium-wrappers'; await s.ready; console.log('ABYTES', s.crypto_secretstream_xchacha20poly1305_ABYTES)"
```
Expected: prints `ABYTES 17`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add libsodium-wrappers for client-side E2E crypto"
```

---

## Task 1: Key generation + URL codec

**Files:**
- Create: `lib/e2e/crypto.ts`
- Test: `test/e2e-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e-crypto.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, generateKey, encodeKey, decodeKey } from "../lib/e2e/crypto";

before(async () => {
  await ready();
});

test("generateKey returns a 32-byte key and is random", () => {
  const a = generateKey();
  const b = generateKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

test("encodeKey/decodeKey round-trips (base64url, no padding)", () => {
  const k = generateKey();
  const s = encodeKey(k);
  assert.match(s, /^[A-Za-z0-9_-]+$/); // url-safe, no '+', '/', '='
  assert.deepEqual(decodeKey(s), k);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: FAIL — `Cannot find module '../lib/e2e/crypto'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/e2e/crypto.ts
import sodium from "libsodium-wrappers";

/** Plaintext chunk size for streaming content encryption (locked, spec §4). */
export const PT_CHUNK = 65536; // 64 KiB

/** Await once before calling any synchronous function in this module. */
export async function ready(): Promise<void> {
  await sodium.ready;
}

/** Fresh random 32-byte content key. Requires `ready()` first. */
export function generateKey(): Uint8Array {
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/** Encode a key for the URL fragment (base64url, no padding). */
export function encodeKey(key: Uint8Array): string {
  return sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Decode a key from the URL fragment. */
export function decodeKey(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/e2e/crypto.ts test/e2e-crypto.test.ts
git commit -m "feat(e2e): key generation + base64url URL codec"
```

---

## Task 2: Encrypted file metadata

**Files:**
- Modify: `lib/e2e/crypto.ts`
- Test: `test/e2e-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to test/e2e-crypto.test.ts
import { encryptMeta, decryptMeta } from "../lib/e2e/crypto";

test("encryptMeta/decryptMeta round-trips name + type", () => {
  const key = generateKey();
  const blob = encryptMeta({ name: "résumé final.pdf", type: "application/pdf" }, key);
  assert.deepEqual(decryptMeta(blob, key), {
    name: "résumé final.pdf",
    type: "application/pdf",
  });
});

test("decryptMeta with the wrong key throws", () => {
  const blob = encryptMeta({ name: "a.png", type: "image/png" }, generateKey());
  assert.throws(() => decryptMeta(blob, generateKey()));
});

test("enc_meta does not leak the filename in cleartext", () => {
  const blob = encryptMeta({ name: "secret-name.txt", type: "text/plain" }, generateKey());
  const hay = new TextDecoder("latin1").decode(blob);
  assert.ok(!hay.includes("secret-name"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: FAIL — `encryptMeta is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to lib/e2e/crypto.ts

export interface FileMeta {
  name: string;
  type: string;
}

/** Encrypt {name,type} with the content key (secretbox; nonce prefixed). */
export function encryptMeta(meta: FileMeta, key: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(meta)),
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return out;
}

/** Reverse of encryptMeta. Throws if the key is wrong or the blob is tampered. */
export function decryptMeta(blob: Uint8Array, key: Uint8Array): FileMeta {
  const n = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = blob.subarray(0, n);
  const cipher = blob.subarray(n);
  const msg = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return JSON.parse(sodium.to_string(msg)) as FileMeta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/e2e/crypto.ts test/e2e-crypto.test.ts
git commit -m "feat(e2e): encrypted file metadata (name + type)"
```

---

## Task 3: Streaming content encryption / decryption

**Files:**
- Modify: `lib/e2e/crypto.ts`
- Test: `test/e2e-crypto.test.ts`

**Format:** output stream = `[header(24)] [frame…]`. Each non-final frame is exactly `CIPHER_CHUNK` (65553) bytes (a `PT_CHUNK` plaintext message + 17). The final frame carries `TAG_FINAL` and is `0..PT_CHUNK` plaintext + 17. The decryptor reads `CIPHER_CHUNK`-sized frames; the trailing bytes are the final frame.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/e2e-crypto.test.ts
import { encryptChunks, decryptChunks, PT_CHUNK } from "../lib/e2e/crypto";

// helpers
async function* one(bytes: Uint8Array) {
  yield bytes;
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
function bytes(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + 3) % 251);
}

for (const size of [0, 1, 100, PT_CHUNK - 1, PT_CHUNK, PT_CHUNK + 1, PT_CHUNK * 3 + 17]) {
  test(`content round-trips at ${size} bytes`, async () => {
    const key = generateKey();
    const data = bytes(size);
    const cipher = await collect(encryptChunks(one(data), key));
    const plain = await collect(decryptChunks(one(cipher), key));
    assert.deepEqual(plain, data);
  });
}

test("decrypt with the wrong key throws", async () => {
  const cipher = await collect(encryptChunks(one(bytes(5000)), generateKey()));
  await assert.rejects(() => collect(decryptChunks(one(cipher), generateKey())));
});

test("a flipped ciphertext byte throws", async () => {
  const key = generateKey();
  const cipher = await collect(encryptChunks(one(bytes(5000)), key));
  cipher[cipher.length - 1] ^= 0xff;
  await assert.rejects(() => collect(decryptChunks(one(cipher), key)));
});

test("truncation (missing final frame) throws", async () => {
  const key = generateKey();
  // 2 full chunks + a final → drop the last (final) frame entirely
  const cipher = await collect(encryptChunks(one(bytes(PT_CHUNK * 2 + 10)), key));
  const truncated = cipher.subarray(0, 24 + (PT_CHUNK + 17) * 2); // header + 2 full frames, no final
  await assert.rejects(() => collect(decryptChunks(one(truncated), key)));
});

test("ciphertext does not contain the plaintext", async () => {
  const key = generateKey();
  const marker = sodium.from_string("FEATHERDROP_SECRET_MARKER");
  const cipher = await collect(encryptChunks(one(marker), key));
  const hay = new TextDecoder("latin1").decode(cipher);
  assert.ok(!hay.includes("FEATHERDROP_SECRET_MARKER"));
});
```

(Add `import sodium from "libsodium-wrappers";` at the top of the test file for the last test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: FAIL — `encryptChunks is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to lib/e2e/crypto.ts

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Encrypt a plaintext byte stream into [header][frames…] using secretstream.
 * Non-final frames are PT_CHUNK plaintext; the final frame carries TAG_FINAL
 * (so truncation is detectable). Works over any AsyncIterable of chunks.
 */
export async function* encryptChunks(
  source: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): AsyncGenerator<Uint8Array> {
  await sodium.ready;
  const { state, header } =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  yield header;

  let buffer = new Uint8Array(0);
  for await (const part of source) {
    buffer = concat(buffer, part);
    // Emit full chunks, but keep at least 1 byte (or one full chunk) back so the
    // very last push can be tagged FINAL.
    while (buffer.length > PT_CHUNK) {
      const chunk = buffer.subarray(0, PT_CHUNK);
      buffer = buffer.subarray(PT_CHUNK);
      yield sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        null,
        TAG_MESSAGE,
      );
    }
  }
  // Flush the remainder (0..PT_CHUNK bytes) as the FINAL frame.
  yield sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    buffer,
    null,
    TAG_FINAL,
  );
}

/**
 * Decrypt a [header][frames…] stream produced by encryptChunks. Throws on a
 * wrong key, a tampered frame, or a stream missing its TAG_FINAL frame.
 */
export async function* decryptChunks(
  source: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): AsyncGenerator<Uint8Array> {
  await sodium.ready;
  const HEADERBYTES =
    sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const ABYTES = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  const CIPHER_CHUNK = PT_CHUNK + ABYTES;

  let buffer = new Uint8Array(0);
  let state: sodium.StateAddress | null = null;

  for await (const part of source) {
    buffer = concat(buffer, part);
    if (state === null) {
      if (buffer.length < HEADERBYTES) continue;
      const header = buffer.subarray(0, HEADERBYTES);
      buffer = buffer.subarray(HEADERBYTES);
      state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        header,
        key,
      );
    }
    // Process full frames, keeping at least one frame back for the FINAL check.
    while (buffer.length > CIPHER_CHUNK) {
      const frame = buffer.subarray(0, CIPHER_CHUNK);
      buffer = buffer.subarray(CIPHER_CHUNK);
      const r = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state,
        frame,
        null,
      );
      if (r === false) throw new Error("decryption failed");
      yield r.message;
    }
  }

  if (state === null) throw new Error("ciphertext too short (no header)");
  const last = sodium.crypto_secretstream_xchacha20poly1305_pull(
    state,
    buffer,
    null,
  );
  if (last === false) throw new Error("decryption failed");
  if (last.tag !== TAG_FINAL) throw new Error("stream truncated");
  yield last.message;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: PASS (all content sizes + tamper/truncation/leak tests).

- [ ] **Step 5: Commit**

```bash
git add lib/e2e/crypto.ts test/e2e-crypto.test.ts
git commit -m "feat(e2e): streaming content encryption/decryption (secretstream, 64 KiB frames)"
```

---

## Task 4: Password key-wrapping (Argon2id)

**Files:**
- Modify: `lib/e2e/crypto.ts`
- Test: `test/e2e-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to test/e2e-crypto.test.ts
import { wrapKey, unwrapKey } from "../lib/e2e/crypto";

test("wrapKey/unwrapKey round-trips with the right password", () => {
  const key = generateKey();
  const { wrapped, salt } = wrapKey(key, "correct horse battery staple");
  assert.deepEqual(unwrapKey(wrapped, salt, "correct horse battery staple"), key);
});

test("unwrapKey with the wrong password throws", () => {
  const { wrapped, salt } = wrapKey(generateKey(), "right");
  assert.throws(() => unwrapKey(wrapped, salt, "wrong"));
});

test("wrapped key does not contain the bare key", () => {
  const key = generateKey();
  const { wrapped } = wrapKey(key, "pw");
  const hay = new TextDecoder("latin1").decode(wrapped);
  assert.ok(!hay.includes(new TextDecoder("latin1").decode(key)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: FAIL — `wrapKey is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to lib/e2e/crypto.ts

// Argon2id parameters (spec §4 — tuned to still run on mobile browsers).
const PW_OPSLIMIT = 3;
const PW_MEMLIMIT = 64 * 1024 * 1024; // 64 MiB

function deriveKek(password: string, salt: Uint8Array): Uint8Array {
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES, // 32
    password,
    salt,
    PW_OPSLIMIT,
    PW_MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Wrap the content key with a password-derived key. Returns wrapped + salt. */
export function wrapKey(
  key: Uint8Array,
  password: string,
): { wrapped: Uint8Array; salt: Uint8Array } {
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const kek = deriveKek(password, salt);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(key, nonce, kek);
  const wrapped = new Uint8Array(nonce.length + cipher.length);
  wrapped.set(nonce, 0);
  wrapped.set(cipher, nonce.length);
  return { wrapped, salt };
}

/** Unwrap the content key. Throws on a wrong password or tampered blob. */
export function unwrapKey(
  wrapped: Uint8Array,
  salt: Uint8Array,
  password: string,
): Uint8Array {
  const kek = deriveKek(password, salt);
  const n = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = wrapped.subarray(0, n);
  const cipher = wrapped.subarray(n);
  return sodium.crypto_secretbox_open_easy(cipher, nonce, kek);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/e2e-crypto.test.ts`
Expected: PASS (all tests). Note: Argon2id at 64 MiB takes ~0.1–0.5 s per call — the 2 wrap/unwrap tests add a moment.

- [ ] **Step 5: Commit**

```bash
git add lib/e2e/crypto.ts test/e2e-crypto.test.ts
git commit -m "feat(e2e): Argon2id password key-wrapping (wrap/unwrap)"
```

---

## Task 5: Full-suite + lint gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all existing tests + the new `e2e-crypto` tests pass, 0 fail.

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: tsc clean; ESLint no errors. If ESLint flags the `sodium.StateAddress` type, import the type from `libsodium-wrappers` or use `ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_push>["state"]`.

- [ ] **Step 3: Commit any lint fixes**

```bash
git add -A
git commit -m "chore(e2e): satisfy tsc + eslint for crypto core"
```

---

## Self-Review

**Spec coverage (Phase 1 scope = spec §4):**
- XChaCha20-Poly1305 secretstream, 64 KiB chunks, TAG_FINAL → Task 3 ✓
- 24-byte header, 17-byte tag framing → Task 3 ✓
- metadata via `crypto_secretbox`, nonce-prefixed → Task 2 ✓
- key = 32 B from keygen → Task 1 ✓
- base64url key codec for `#k=` → Task 1 ✓ (the `#k=` wrapping itself lives in the upload/download flow, Phases 4–5)
- password wrap via Argon2id (ops 3 / mem 64 MiB, 16-byte salt) → Task 4 ✓
- "nothing hand-rolled" → only libsodium primitives ✓
- Out of Phase-1 scope (own plans): blob layout assembly (`[varint enc_meta][header][frames]`), OPFS, service worker, upload/download/preview flows, server, schema/migration, copy.

**Placeholder scan:** none — every step has runnable code/commands.

**Type consistency:** `generateKey/encodeKey/decodeKey` (Task 1), `FileMeta/encryptMeta/decryptMeta` (Task 2), `encryptChunks/decryptChunks/PT_CHUNK` (Task 3), `wrapKey/unwrapKey` (Task 4) — names consistent across tasks and tests. `PT_CHUNK` defined Task 1, reused Task 3. `CIPHER_CHUNK` derived locally in Task 3.

---

## Next phases (separate plans, written when reached)

2. **OPFS scratch + tus spike** — `lib/e2e/opfs-scratch.ts`; first prove tus-js-client resumes from a seekable OPFS `File` (spec §13 spike) before building the upload flow.
3. **Service-worker streaming download** — `public/sw-download.js` + `lib/e2e/stream-download.ts` (+ FS-Access-API / Blob fallbacks).
4. **Upload flow** — wire `encryptChunks` + OPFS + blob layout into `app/page.tsx`; build `#k=` link.
5. **Download flow** — `components/DownloadView.tsx`: fetch ciphertext → `decryptChunks` → stream-download; password prompt path.
6. **Client-side preview** — decrypt previewable blobs in-browser, render via `blob:` URL (replaces server `?inline=1`).
7. **Server simplification + schema/migration** — drop server crypto/master-key/inline; `format` column + dual-format read; `enc_meta`/`wrapped_key`/`kdf_salt`.
8. **Copy + docs + v4 release** — zero-knowledge claim across README/i18n/template/support thread; release notes.
