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
