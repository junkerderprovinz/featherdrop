# featherdrop seekable encryption format (v4 content) — design

**Goal:** make encrypted content **randomly seekable**, so large videos can be
previewed/streamed with real seeking (and range-served) instead of re-decrypting
from byte 0. Today's libsodium **secretstream** is sequential + stateful: to get
plaintext at offset X you must decrypt every frame from 0 (see the v5.0.0
streaming-preview limitation). Stays zero-knowledge; backward compatible with all
existing shares.

## Current format (keep, for reads)
Blob = `[varint(metaLen)][enc_meta][secretstream header 24][frames…]`, frames are
secretstream (`crypto.ts encryptChunks/decryptChunks`, 64 KiB plaintext + 17 B
tag, chained state → sequential). `enc_meta` = secretbox(`FileMeta{name,type,size?}`).
DB `format`: 1 = legacy age, 2 = ZK single, 3 = ZK multi-file.

## New seekable content (format 4)
Replace the **content** encoding only (envelope + enc_meta unchanged); each chunk
is encrypted **independently** so any chunk decrypts on its own → O(1) seek.

- **Per-file content key** `K` (32 B random), as today.
- **Per-chunk AEAD:** chunk `i` (64 KiB plaintext, last may be short) →
  `XChaCha20-Poly1305(K, nonce_i, plaintext_i, aad_i)`.
  - `nonce_i` = 24 B, derived deterministically from a per-file random 24 B
    `base_nonce` (stored in enc_meta) and the chunk index: `nonce_i = base_nonce`
    with its last 8 bytes XORed by the big-endian counter `i`. Uniqueness is
    guaranteed by the **fresh per-file K + fresh base_nonce + monotonic i** (no
    nonce reuse across chunks of a file; never reused across files because K is
    fresh). Using XChaCha20's 24 B nonce keeps a wide margin.
  - `aad_i` binds **position + finality**: `aad = u32be(i) || finalFlag(1B)`.
    The last chunk has `finalFlag=1`, all others `0`. This authenticates each
    chunk's index (no reordering/splicing) and marks the end.
- **Authenticated length:** enc_meta carries the exact plaintext `size` and the
  `chunkSize` (64 KiB). Truncation/extension is detected by: the final chunk's
  `finalFlag=1` AAD + the total `size` (a missing tail chunk fails the AAD/size
  check). So we keep secretstream's truncation guarantee without its chaining.
- **Random access:** chunk `i` lives at a computable ciphertext offset
  `headerLen + i*(chunkSize + 16)`. To serve plaintext `[a,b]`: decrypt chunks
  `floor(a/chunkSize) .. floor(b/chunkSize)`, each independently — fetch only
  those encrypted bytes (HTTP Range on the blob) and decrypt them. **True seek.**

### Blob layout (format 4)
`[varint(metaLen)][enc_meta][chunk0][chunk1]…[chunkN]` — no separate stream
header (base_nonce lives in enc_meta). `enc_meta` = secretbox over
`{name, type, size, chunkSize, baseNonce(b64), v:4}`.

## Versioning / compatibility
- New DB `format` values: **4 = ZK single (seekable)**, **5 = ZK multi-file
  (seekable)** — OR keep format 2/3 and add a `contentFormat` byte in enc_meta.
  Decision: add a small **`cf` (content-format) field inside enc_meta** (1 =
  secretstream, 2 = per-chunk-AEAD) so the DB `format` (2/3) is unchanged and the
  decrypter branches on `cf`. New uploads write `cf=2`; old blobs (no `cf`) =
  `cf=1` → existing secretstream path. **Both decrypt paths kept forever** (old
  links must keep working).
- Multi-file (format 3) reuses the same per-chunk content for the concatenated
  stream; `splitByManifest` is unchanged (it slices plaintext).

## What this unblocks
The streaming-preview SW/`?preview` Range path can fetch + decrypt **only the
requested chunk range** instead of from 0 → real seeking for large videos, and
much less bandwidth per seek. The v5.0.0 "far-seek re-decrypts from 0" note goes
away for new (cf=2) shares.

## Security (must security-review)
- Nonce uniqueness (the one real hazard): fresh K + fresh 24 B base_nonce per
  file + monotonic counter in the low 8 bytes → no `(K,nonce)` reuse. Document +
  test the derivation; cap chunk count so the counter can't wrap (2^64 is safe).
- AAD binds index + finality → no chunk reordering, duplication, or truncation.
- Tamper/wrong-key → AEAD verify fails per chunk (same guarantee as today).
- enc_meta still secretbox (unchanged); the new fields are inside it (ZK intact).
- Keep the libsodium primitive (`crypto_aead_xchacha20poly1305_ietf_*`); no
  hand-rolled crypto.

## Testing
- Pure round-trip: encrypt N chunks → decrypt any single chunk / arbitrary range
  → byte-exact; tamper a chunk → fail; reorder/drop a chunk → fail; truncate →
  fail; wrong key → fail; nonce-derivation uniqueness across a large index.
- Range correctness across chunk boundaries; 0-byte and 1-chunk files.
- Backward-compat: a cf=1 (secretstream) blob still decrypts via the old path.
- E2E: upload a >50 MB video (cf=2), seek near the end → plays quickly (only the
  tail chunks fetched/decrypted).

## Rollout
TDD the crypto core → wire into upload (cf=2 for new shares) + the streaming
preview (chunk-range fetch+decrypt) → security review → keep old-format reads →
part of the bundled next major.
