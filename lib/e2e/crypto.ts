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
