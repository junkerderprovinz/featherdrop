// libsodium-wrappers-sumo's ESM build uses top-level await. A STATIC
// `import sodium from "..."` would make this module — and everything that
// imports it, up through pipeline.ts → download-flow.ts → DownloadView — an
// "async module". Next.js cannot resolve a Client Component that lives in an
// async-module graph: its client reference resolves to `undefined`, so the
// server renders `<undefined/>` and throws "Element type is invalid" (React
// #306) on the download page. Loading sodium lazily via a dynamic import inside
// ready() keeps the whole graph synchronous, which fixes the reference. It also
// defers the WASM load until the first encrypt/decrypt actually needs it.
// @types/libsodium-wrappers-sumo declares the module with `export =` (no
// `default`), so the type of the namespace IS the sodium object.
type Sodium = typeof import("libsodium-wrappers-sumo");

// The opaque secretstream state handle, derived from a method's return type so
// we don't need a separate (interop-fragile) named type import from the module.
type StateAddress =
  ReturnType<Sodium["crypto_secretstream_xchacha20poly1305_init_push"]>["state"];

// Assigned by ready() before any synchronous function below runs. The definite-
// assignment assertion lets the existing `sodium.xxx` call sites stay unchanged.
let sodium!: Sodium;
let readyPromise: Promise<void> | null = null;

/** Plaintext chunk size for streaming content encryption (locked, spec §4). */
export const PT_CHUNK = 65536; // 64 KiB

/** Await once before calling any synchronous function in this module. */
export async function ready(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const mod = await import("libsodium-wrappers-sumo");
    // Under esModuleInterop / bundler interop a dynamic import of this CJS
    // module yields { default: <sodium> }; without interop it returns the
    // object directly. Accept both.
    const lib =
      (mod as unknown as { default?: Sodium }).default ??
      (mod as unknown as Sodium);
    await lib.ready;
    sodium = lib;
  })();
  return readyPromise;
}

/** Fresh random 32-byte content key. Requires `ready()` first. */
export function generateKey(): Uint8Array {
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/**
 * XChaCha20-Poly1305-IETF nonce length (24 B). The seekable content format
 * (cf=2) uses one random base nonce of this size per file. Requires `ready()`.
 */
export function aeadNonceBytes(): number {
  return sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
}

/**
 * XChaCha20-Poly1305-IETF auth-tag length (16 B). Each emitted seekable chunk is
 * plaintext + this many tag bytes. Requires `ready()`.
 */
export function aeadTagBytes(): number {
  return sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
}

/** Fresh random base nonce (24 B) for a seekable file. Requires `ready()`. */
export function generateAeadBaseNonce(): Uint8Array {
  return sodium.randombytes_buf(aeadNonceBytes());
}

/**
 * AEAD-encrypt one seekable chunk: XChaCha20-Poly1305-IETF over `plaintext` with
 * additional data `aad`, nonce `nonce` and content key `key`. Returns
 * ciphertext+tag (plaintext.length + 16). No secret nonce. Requires `ready()`.
 */
export function aeadEncrypt(
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null, // nsec — always null for this construction
    nonce,
    key,
  );
}

/**
 * Reverse of aeadEncrypt. Throws on a wrong key, tampered ciphertext, wrong AAD
 * (e.g. a swapped/relabelled chunk), or wrong nonce. Requires `ready()`.
 */
export function aeadDecrypt(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, // nsec
    ciphertext,
    aad,
    nonce,
    key,
  );
}

/** Encode bytes as standard base64 (with padding) — used for enc_meta fields. */
export function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/** Decode standard base64 (with padding) back to bytes. */
export function fromBase64(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

/** Encode a key for the URL fragment (base64url, no padding). */
export function encodeKey(key: Uint8Array): string {
  return sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Decode a key from the URL fragment. */
export function decodeKey(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Download-authorization proof: base64url(SHA-256(K)) of the raw content key —
 * 43 chars, unpadded. One-way: the server stores it at finalize and requires it
 * (header `x-fd-key-verifier`) before counting/burning a format=2 download, but
 * can never recover K from it. Requires `ready()` first.
 */
export function computeKeyVerifier(key: Uint8Array): string {
  return sodium.to_base64(
    sodium.crypto_hash_sha256(key),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}

export interface FileMeta {
  name: string;
  type: string;
  /**
   * Plaintext byte length of the file (format-2 single-file only). Lives INSIDE
   * the client-encrypted enc_meta, so the server never sees it — zero-knowledge
   * is preserved. Optional: shares uploaded before this field existed omit it,
   * and consumers that need the exact plaintext length (e.g. the streaming video
   * preview's Range math) must fall back when it is absent. Everything else
   * ignores it, so adding it does not change any existing behavior.
   */
  size?: number;
  /**
   * Content-format selector (see ./seekable.ts). 1 = libsodium secretstream
   * (sequential, the original encoding); 2 = per-chunk XChaCha20-Poly1305 AEAD
   * (independently decryptable chunks → O(1) seek). ABSENT means cf=1 — every
   * blob written before this field existed decrypts through the secretstream
   * path unchanged. Lives INSIDE the encrypted enc_meta, so the server never
   * learns which encoding a blob uses (zero-knowledge preserved).
   */
  cf?: 1 | 2;
  /**
   * cf=2 only: plaintext chunk size (always PT_CHUNK = 65536). Stored so a future
   * format can change it without breaking old seekable blobs. Inside enc_meta.
   */
  chunkSize?: number;
  /**
   * cf=2 only: the per-file random 24-byte base nonce, base64 (standard, no
   * padding stripping needed — sodium round-trips it). Every chunk's nonce is
   * derived from this + its index (see deriveNonce). Inside enc_meta, so the
   * server never sees it (and it is useless without the content key K anyway).
   */
  baseNonce?: string;
}

/**
 * JSON-serialize `value` and encrypt it with the content key (secretbox; nonce
 * prefixed). The byte layout is unchanged from the inlined version, so existing
 * format-2 enc_meta blobs stay byte-identical — encryptMeta delegates here, and
 * the multi-file manifest crypto reuses it (no duplicated secretbox logic).
 */
function encryptJson(value: unknown, key: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(value)),
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return out;
}

/** Reverse of encryptJson. Throws if the key is wrong or the blob is tampered. */
function decryptJson<T>(blob: Uint8Array, key: Uint8Array): T {
  const n = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = blob.subarray(0, n);
  const cipher = blob.subarray(n);
  const msg = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return JSON.parse(sodium.to_string(msg)) as T;
}

/** Encrypt {name,type} with the content key (secretbox; nonce prefixed). */
export function encryptMeta(meta: FileMeta, key: Uint8Array): Uint8Array {
  return encryptJson(meta, key);
}

/** Reverse of encryptMeta. Throws if the key is wrong or the blob is tampered. */
export function decryptMeta(blob: Uint8Array, key: Uint8Array): FileMeta {
  return decryptJson<FileMeta>(blob, key);
}

/**
 * Encrypt a multi-file manifest (format 3) with the content key — same secretbox
 * envelope as encryptMeta, just a richer object. Kept here so it shares the one
 * encryptJson helper. The Manifest type lives in ./multi-file to avoid a cycle.
 */
export function encryptManifest(
  manifest: { files: { name: string; type: string; size: number }[] },
  key: Uint8Array,
): Uint8Array {
  return encryptJson(manifest, key);
}

/** Reverse of encryptManifest. Throws if the key is wrong or the blob is tampered. */
export function decryptManifest<
  T extends { files: { name: string; type: string; size: number }[] },
>(blob: Uint8Array, key: Uint8Array): T {
  return decryptJson<T>(blob, key);
}

function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 0);
  out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), a.length);
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

  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
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

  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let state: StateAddress | null = null;

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
      // pull() returns `false` on auth failure (wrong key / tampered frame); the
      // bundled @types omit this `| false`, hence the cast. Never yield on failure.
      const r = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state,
        frame,
        null,
      ) as unknown as { message: Uint8Array; tag: number } | false;
      if (r === false) throw new Error("decryption failed");
      yield r.message;
    }
  }

  if (state === null) throw new Error("ciphertext too short (no header)");
  const last = sodium.crypto_secretstream_xchacha20poly1305_pull(
    state,
    buffer,
    null,
  ) as unknown as { message: Uint8Array; tag: number } | false;
  if (last === false) throw new Error("decryption failed");
  if (last.tag !== TAG_FINAL) throw new Error("stream truncated");
  yield last.message;
}

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
