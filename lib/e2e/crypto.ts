// libsodium's ESM build uses top-level await, so a static import would turn
// this module and every importer into an async module. The dynamic import in
// ready() avoids that and defers the WASM load until crypto is first needed.
// The types declare the module with `export =`, so the namespace type is the
// sodium object.
type Sodium = typeof import("libsodium-wrappers-sumo");

// Derived from a return type to avoid a fragile named type import.
type StateAddress =
  ReturnType<Sodium["crypto_secretstream_xchacha20poly1305_init_push"]>["state"];

// Assigned by ready() before any synchronous function below runs.
let sodium!: Sodium;
let readyPromise: Promise<void> | null = null;

/** Plaintext chunk size for streaming content encryption. */
export const PT_CHUNK = 65536;

/** Await once before calling any synchronous function in this module. */
export async function ready(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const mod = await import("libsodium-wrappers-sumo");
    // With bundler interop the CJS module arrives as { default }, without it
    // as the object itself.
    const lib =
      (mod as unknown as { default?: Sodium }).default ??
      (mod as unknown as Sodium);
    await lib.ready;
    sodium = lib;
  })();
  return readyPromise;
}

export function generateKey(): Uint8Array {
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/** Nonce length of XChaCha20-Poly1305-IETF (24 bytes), the seekable format's base nonce. */
export function aeadNonceBytes(): number {
  return sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
}

/** Auth tag length (16 bytes) added to every seekable chunk. */
export function aeadTagBytes(): number {
  return sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
}

export function generateAeadBaseNonce(): Uint8Array {
  return sodium.randombytes_buf(aeadNonceBytes());
}

/** Encrypts one seekable chunk and returns ciphertext plus tag. */
export function aeadEncrypt(
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key,
  );
}

/**
 * Reverse of aeadEncrypt. Throws on a wrong key, nonce or AAD (a swapped chunk)
 * and on tampered ciphertext.
 */
export function aeadDecrypt(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    aad,
    nonce,
    key,
  );
}

/** Standard padded base64, used for the enc_meta fields. */
export function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

/** Encodes a key for the URL fragment as unpadded base64url. */
export function encodeKey(key: Uint8Array): string {
  return sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function decodeKey(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * The download proof base64url(SHA-256(K)), 43 characters. The server requires
 * it in `x-fd-key-verifier` before counting or burning a download but cannot
 * recover K from it.
 */
export function computeKeyVerifier(key: Uint8Array): string {
  return sodium.to_base64(
    sodium.crypto_hash_sha256(key),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}

/** The file metadata, encrypted into enc_meta so the server never sees it. */
export interface FileMeta {
  name: string;
  type: string;
  /**
   * Plaintext length of a single-file share. Older shares lack it, so the video
   * preview's Range math falls back when it is missing.
   */
  size?: number;
  /**
   * Content format (see ./seekable.ts): 1 is the sequential secretstream, 2 is
   * per-chunk AEAD that can seek. Absent means 1.
   */
  cf?: 1 | 2;
  /** cf=2 plaintext chunk size, stored so a later format can change it. */
  chunkSize?: number;
  /** cf=2 random base nonce in base64; each chunk's nonce derives from it. */
  baseNonce?: string;
}

/** JSON-encodes value and seals it with secretbox, nonce first. */
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

/** Reverse of encryptJson. Throws on a wrong key or a tampered blob. */
function decryptJson<T>(blob: Uint8Array, key: Uint8Array): T {
  const n = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = blob.subarray(0, n);
  const cipher = blob.subarray(n);
  const msg = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return JSON.parse(sodium.to_string(msg)) as T;
}

export function encryptMeta(meta: FileMeta, key: Uint8Array): Uint8Array {
  return encryptJson(meta, key);
}

/** Reverse of encryptMeta. Throws on a wrong key or a tampered blob. */
export function decryptMeta(blob: Uint8Array, key: Uint8Array): FileMeta {
  return decryptJson<FileMeta>(blob, key);
}

/**
 * Encrypts a format 3 manifest in the same envelope as encryptMeta. The
 * Manifest type lives in ./multi-file to avoid an import cycle.
 */
export function encryptManifest(
  manifest: { files: { name: string; type: string; size: number }[] },
  key: Uint8Array,
): Uint8Array {
  return encryptJson(manifest, key);
}

/** Reverse of encryptManifest. Throws on a wrong key or a tampered blob. */
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
 * Encrypts a plaintext stream into a secretstream header and frames of
 * PT_CHUNK plaintext each. The last frame carries TAG_FINAL, so truncation is
 * detectable.
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
    // Something always stays behind so the last push can carry TAG_FINAL.
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
  yield sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    buffer,
    null,
    TAG_FINAL,
  );
}

/**
 * Decrypts a stream produced by encryptChunks. Throws on a wrong key, a
 * tampered frame or a missing TAG_FINAL frame.
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
    // One frame always stays behind for the TAG_FINAL check.
    while (buffer.length > CIPHER_CHUNK) {
      const frame = buffer.subarray(0, CIPHER_CHUNK);
      buffer = buffer.subarray(CIPHER_CHUNK);
      // pull() returns false on an auth failure, which the bundled types
      // leave out.
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

// Argon2id parameters, sized to still run in mobile browsers.
const PW_OPSLIMIT = 3;
const PW_MEMLIMIT = 64 * 1024 * 1024;

function deriveKek(password: string, salt: Uint8Array): Uint8Array {
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    PW_OPSLIMIT,
    PW_MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Wraps the content key with a password-derived key. */
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

/** Unwraps the content key. Throws on a wrong password or a tampered blob. */
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
