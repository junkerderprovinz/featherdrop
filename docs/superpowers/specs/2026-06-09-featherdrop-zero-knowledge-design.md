# featherdrop — Zero-Knowledge (End-to-End Encryption) Design

**Date:** 2026-06-09
**Status:** Draft for review
**Author:** junkerderprovinz (with Claude, via superpowers:brainstorming)
**Target:** featherdrop next major version (v4.0.0)

---

## 1. Goal

Make featherdrop **zero-knowledge**: the server (and therefore the host, an
attacker who compromises the server, or any third party) can **never** read an
uploaded file's contents or its filename. Encryption and decryption happen
**entirely in the browser**; the per-file key never reaches the server.

This turns the privacy claim from "encrypted at rest" into the genuine,
verifiable "we literally cannot read your files — by design", matching the
WeTransfer-contrast the project wants to make.

## 2. Non-goals

- Migrating *existing* v1 (at-rest) files to v2 — they remain downloadable via a
  legacy read path until they expire (see §9).
- Protecting against a malicious *client* build (if the served JS is tampered
  with, E2E guarantees break — inherent to all browser-E2E apps; out of scope).
- Hiding file **size**, upload **time**, or access **patterns** from the server
  (metadata the server inherently sees; only contents + filename are hidden).
- Multi-recipient / per-recipient keys, password rotation (YAGNI for v1).

## 3. Architecture shift

| | v1 (current, at-rest) | v2 (zero-knowledge) |
|---|---|---|
| Upload | browser → plaintext → server encrypts (age) | **browser encrypts** → server stores ciphertext only |
| Download | server decrypts → plaintext stream | server streams ciphertext → **browser decrypts** |
| Key | sent to server transiently on download | **never** sent to server (URL `#fragment` or password-derived) |
| Filename / type | stored on server | **client-encrypted**; server stores an opaque blob |
| Server role | crypto engine + store | **dumb ciphertext store + metadata + limit/expiry enforcement** |

The server gets **simpler**: no age, no key handling, no server-side decrypt, no
inline decrypt, no master-key mode.

## 4. Cryptography

**Library:** `libsodium-wrappers` (WASM) in the browser — well-supported,
streaming-capable, audited. Same primitives available in Node for tests.

**Per-file content key** `K` — 32 random bytes from `crypto_secretstream_*_keygen()`.

**Content encryption** — `crypto_secretstream_xchacha20poly1305` (XChaCha20-
Poly1305), the standard streaming AEAD:
- File is split into fixed-size **64 KiB** chunks (**locked**; ~0.03 % tag
  overhead, good throughput, low memory).
- Each chunk is an authenticated secretstream message; the final chunk carries
  the `TAG_FINAL` so truncation is detectable.
- The stream **header** (24 bytes) is written first in the blob.

**Metadata encryption** — the real filename + MIME type are serialized to JSON
and encrypted with `K` via `crypto_secretbox` (XSalsa20-Poly1305; random 24-byte
nonce prefixed) into a small `enc_meta` blob. The server stores `enc_meta`
opaquely and never sees the name/type.

**Blob layout on the server** (one object per share):
```
[ varint: enc_meta length ][ enc_meta bytes ][ secretstream header ][ chunk 0 ][ chunk 1 ] … [ chunk N (FINAL) ]
```
So one streamed read yields metadata first, then the content stream.

**Key delivery — two modes only (master-key mode removed):**
1. **Link mode (default):** `K` is base64url-encoded (no padding, ~43 chars) into
   the URL fragment as `https://host/d/<slug>#k=<K>` (keeps today's `#k=`
   convention). The fragment is never sent in any HTTP request.
2. **Password mode (optional):** `K` is wrapped with a password-derived key
   (`crypto_pwhash`, Argon2id `ALG_ARGON2ID13`, **opslimit 3, memlimit 64 MiB**,
   random 16-byte salt — chosen so it still runs on mobile browsers; tunable
   upward) → `wrapped_key`. The server stores `wrapped_key` + `kdf_salt`
   (opaque). The share link has **no** fragment; the downloader types the
   password, the client derives the KEK, unwraps `K`, and decrypts. The server
   never sees the password or `K`. Still zero-knowledge.

**Locked parameters (v4):** content = XChaCha20-Poly1305 secretstream, 64 KiB
chunks; metadata = `crypto_secretbox`; password KDF = Argon2id (ops 3 / mem
64 MiB); key = 32 B, base64url in `#k=`. Crypto primitives come only from
libsodium — **nothing hand-rolled**.

## 5. Client components (isolation-first)

Each is a focused module with a clear interface:

### 5.1 `lib/e2e/crypto.ts` — pure crypto
- `generateKey(): Key`
- `encryptStream(plaintext: ReadableStream, key, meta): ReadableStream` (prepends enc_meta + header, chunks content)
- `decryptStream(ciphertext: ReadableStream, key): { meta, plaintext: ReadableStream }`
- `wrapKey(key, password) / unwrapKey(wrapped, salt, password)`
- `encodeKeyForUrl(key) / decodeKeyFromUrl(str)`
- No DOM, no network → fully unit-testable in Node with libsodium.

### 5.2 `lib/e2e/opfs-scratch.ts` — encrypt-to-disk before upload
Encrypting a multi-GB file requires not holding it in RAM and a **seekable**
source for resumable tus. Solution: stream-encrypt the file into an **OPFS**
(Origin Private File System) temp file, then hand that file to tus, then delete
it. Interface: `encryptToScratch(file, key, meta) → File`, `cleanup(handle)`.

### 5.3 `public/sw-download.js` + `lib/e2e/stream-download.ts` — decrypt-to-disk
Cross-browser streaming download (the Firefox-Send / StreamSaver pattern): a
**service worker** exposes a virtual download URL; the page pipes the decrypted
`ReadableStream` to it, and the browser performs a normal download without
buffering the whole file in RAM. Fallback to the **File System Access API**
(`showSaveFilePicker`) where available (Chromium), and to an in-memory Blob for
small files / unsupported browsers (with a size guard).

### 5.4 Upload flow (`app/page.tsx` + hook)
1. user picks file → `generateKey()`
2. `encryptToScratch(file, K, {name, type})` → OPFS ciphertext file
3. tus-upload the OPFS file → server returns `slug`
4. build share URL: link mode `…/d/<slug>#<K>`; password mode upload `wrapped_key`+`salt`, link `…/d/<slug>`
5. cleanup OPFS; show link/QR

### 5.5 Download flow (`components/DownloadView.tsx`)
1. read `K` from URL fragment (or prompt password → derive → unwrap `K`)
2. `fetch('/api/d/<slug>')` → ciphertext `ReadableStream`
3. `decryptStream` → read `enc_meta` first (reveal real filename), then pipe
   plaintext to the service-worker download (or FS Access API)
4. server increments the download count (no key involved)

### 5.6 Preview (`components/DownloadView.tsx`)
Inline image/PDF preview becomes **fully client-side**: for previewable,
unlimited, below a size cap (e.g. 50 MB), decrypt into a `Blob`, render via a
`blob:` object URL in `<img>`/`<embed>`. The server no longer serves `?inline=1`
at all. The existing inert-type allowlist still gates *which* decrypted blobs we
render (defense against a malicious uploader-chosen type).

## 6. Server components

The server keeps tus + Next API but **loses all crypto**:
- **tus endpoint** — unchanged transport; now receives ciphertext.
- **`POST /api/finalize`** — stores the blob, allocates slug, writes the row
  (size, expiry, max_downloads, `enc_meta`, optional `wrapped_key`+`kdf_salt`).
  No encryption, no key, no filename.
- **`GET /api/d/<slug>`** — streams the **raw ciphertext** with
  `Content-Type: application/octet-stream`, `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`. Enforces expiry + download limit
  (burn-after-download deletes the blob). **No key, no decrypt, no `?inline`.**
- Removed: `server/crypto.ts` server-side use, the `fd_key` cookie + authorize
  POST, master-key/`MASTER_KEY`, `ENCRYPT_UPLOADS`, server-side inline preview.

### 6.1 Key verifier (download authorization)

v1 implicitly gated the download count on a valid credential (decrypt-before-
count); v2 streams raw ciphertext, so without a countermeasure **anyone who
learns the slug** (proxy/access logs) could exhaust a limited share and burn the
file without ever holding the key. The fix is a one-way proof of key knowledge:

- **Verifier** = `base64url(SHA-256(K))` of the raw 32-byte content key —
  43 unpadded chars. Computed client-side (`computeKeyVerifier` in
  `lib/e2e/crypto.ts`); the server never sees K, and the verifier cannot
  decrypt anything — it only authorizes.
- **Upload**: the client sends `keyVerifier` in the finalize body (optional
  field, validated as 43-char base64url); stored in the nullable
  `key_verifier` column.
- **Download**: when `key_verifier` is set, `GET /api/d/<slug>` requires the
  header **`x-fd-key-verifier`** and compares it constant-time
  (`verifierMatches` in `lib/key-verifier.ts`). Missing/wrong → `401` and
  **nothing is counted or burned**. The client derives K *before* the fetch
  (link: URL fragment; password: Argon2id unwrap — a wrong password fails
  client-side, no request) and sends the header on every ciphertext GET,
  including the small-file preview prefetch.
- **Backward compatibility**: rows with `key_verifier = NULL` (uploads from
  before this change) are served exactly as before — no header required.

## 7. Data model changes

`files` table (v2 columns):
- keep: `id, slug, size, expires_at, created_at, max_downloads, download_count`
- **remove:** `original_name`, `mime`, `enc_mode`, `enc_key_wrapped`, `encrypted`
  (server no longer knows these)
- **add:** `format INTEGER` (1 = legacy at-rest, 2 = zero-knowledge),
  `enc_meta BLOB` (client-encrypted name+type), `wrapped_key BLOB NULL`,
  `kdf_salt BLOB NULL` (password mode only)

## 8. URL / key format

`https://<host>/d/<slug>#<base64url(K)>` — slug stays the public, server-known
id; the fragment is the secret, client-only. Password mode: no fragment.

## 9. Migration / dual-format

- **New uploads are always v2.**
- **Existing v1 blobs stay readable** via the current server-side path, keyed by
  `format = 1`. The download route branches on `format`.
- After the longest possible expiry window has elapsed since release (≤ 30 days,
  unless `never`-expiry files exist), the v1 path can be removed. `never` v1
  files are the only long-lived case — surfaced in release notes so admins can
  re-share them as v2 if desired.

## 10. Privacy properties this enables

- Server stores only: ciphertext, encrypted metadata, size, timestamps, slug,
  limits — **never** plaintext, filename, type, key, or password.
- Compromising the server (or a stolen backup) yields **nothing readable**.
- New honest claim: *"End-to-end encrypted. The decryption key lives only in
  your share link (or your password) — even the server can't read your files."*
  And still: self-hosted, no accounts, no tracking, auto-deleted.

## 11. Browser support + fallbacks

- libsodium WASM: all modern browsers.
- OPFS: Chromium, Firefox, Safari 17+. Fallback for old browsers: in-memory
  encryption with a size cap (e.g. 500 MB) + a clear message.
- Streaming download: service worker (broad support) with FS-Access-API
  (Chromium) preferred; small-file Blob fallback.
- A capability check on load picks the path and warns if a huge file is selected
  on a browser without OPFS/SW streaming.

## 12. Testing

- **crypto.ts**: round-trip (incl. multi-chunk + final-tag truncation
  detection), metadata encrypt/decrypt, wrap/unwrap, tamper → fail, key URL
  codec — Node + libsodium, no DOM.
- **server**: blob store + expiry + limit/burn (no crypto); `GET /d` streams
  bytes verbatim; asserts the server never receives a key/password param.
- **integration**: encrypt→upload→download→decrypt yields byte-identical output;
  password mode end-to-end; v1 legacy blob still downloads.
- **manual host check**: large-file (multi-GB) upload+download on Chromium +
  Firefox; preview of a v2 image.

## 13. Risks / open questions

- **Biggest risk:** cross-browser large-file streaming (OPFS + service-worker
  download) — Safari quirks, service-worker lifecycle. Mitigation: capability
  detection + fallbacks + a real-device manual test matrix.
- libsodium WASM adds ~150-300 KB to the client bundle (acceptable).
- Resumable-upload UX with OPFS scratch: must clean up temp files on
  abort/refresh (OPFS persists) — add a startup sweep of stale scratch files.
- tus + OPFS file as source: confirm tus-js-client reads an OPFS `File`
  seekably for PATCH resumption (spike before committing the upload module).

## 14. Rollout

- **v4.0.0** (major — breaking crypto model). Release notes call out: new
  zero-knowledge model, master-key mode removed, v1 links readable until expiry.
- Update all copy (README, app i18n, GitHub description, template `<Overview>`,
  templates-repo card, support thread) to the zero-knowledge claim — supersedes
  the "self-hosted/at-rest" wording discussed earlier.
- Build order (one sub-plan each): crypto.ts → OPFS scratch + tus spike →
  service-worker download → upload flow → download flow → client preview →
  server simplification + schema/migration → copy + docs → release.
