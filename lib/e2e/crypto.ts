import sodium from "libsodium-wrappers-sumo";

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
