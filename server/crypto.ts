// File encryption for featherdrop, built on `age` (typage) — Filippo Valsorda's
// audited implementation. age handles the hard part: a streaming, chunked,
// authenticated format (STREAM, 64 KiB AEAD chunks) so multi-GB files encrypt
// and decrypt without buffering the whole thing in memory.
//
// Envelope model — every file is encrypted to a fresh per-file key (an age
// X25519 identity). What happens to that key decides the protection mode:
//   - link-key mode (no password): the key travels in the share URL fragment
//     (#k=...), never reaching the server's database.
//   - password mode: the key is wrapped (wrapKey) with the user's password via
//     age's scrypt passphrase and only the wrapped blob is stored. The bare key
//     is recovered (unwrapKey) at download time after the password check.
//
// Wrapping the *key* rather than re-encrypting the file means a leaked download
// cookie (which carries the bare per-file key) exposes only that one file, never
// the password, and the file is encrypted exactly once.
//
// The original filename + MIME are written *inside* the encrypted stream as a
// length-prefixed JSON header, ahead of the file bytes — so without the key the
// server cannot even see the name.
import {
  Encrypter,
  Decrypter,
  generateIdentity,
  identityToRecipient,
} from "age-encryption";

export interface FileHeader {
  name: string;
  mime: string | null;
}

export interface EncryptResult {
  ciphertext: ReadableStream<Uint8Array>;
  /** age identity (the per-file key) — store wrapped, or hand out in the link. */
  key: string;
}

export interface DecryptResult {
  header: FileHeader;
  plaintext: ReadableStream<Uint8Array>;
}

// A 4-byte big-endian length prefix + UTF-8 JSON header, prepended to the file
// bytes inside the encrypted stream.
function encodeHeader(header: FileHeader): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, 4);
  return out;
}

function prepend(
  prefix: Uint8Array,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Encrypt a stream to a fresh per-file key; returns the ciphertext + that key. */
export async function encryptStream(
  plaintext: ReadableStream<Uint8Array>,
  header: FileHeader,
): Promise<EncryptResult> {
  const key = await generateIdentity();
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(key));

  const framed = prepend(encodeHeader(header), plaintext);
  const ciphertext = await encrypter.encrypt(framed);
  return { ciphertext, key };
}

// Pull exactly `n` bytes off the reader, returning them plus any bytes read past
// the boundary (the start of the file body).
async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: Uint8Array }> {
  const parts: Uint8Array[] = [];
  let have = 0;
  while (have < n) {
    const { done, value } = await reader.read();
    if (done) throw new Error("encrypted stream ended inside the header");
    parts.push(value);
    have += value.length;
  }
  const buf = new Uint8Array(have);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return { head: buf.subarray(0, n), rest: buf.subarray(n) };
}

/** Decrypt a per-file-key stream, recovering the header and the file bytes. */
export async function decryptStream(
  ciphertext: ReadableStream<Uint8Array>,
  key: string,
): Promise<DecryptResult> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(key);

  // age verifies the recipient as part of producing the stream; a wrong key
  // rejects here before any plaintext is yielded.
  const decrypted = await decrypter.decrypt(ciphertext);
  const reader = decrypted.getReader();

  const { head: lenBytes, rest: afterLen } = await readExactly(reader, 4);
  const headerLen = new DataView(
    lenBytes.buffer,
    lenBytes.byteOffset,
    4,
  ).getUint32(0, false);

  let headerBytes: Uint8Array;
  let leftover: Uint8Array;
  if (afterLen.length >= headerLen) {
    headerBytes = afterLen.subarray(0, headerLen);
    leftover = afterLen.subarray(headerLen);
  } else {
    const { head, rest } = await readExactly(
      reader,
      headerLen - afterLen.length,
    );
    headerBytes = new Uint8Array(headerLen);
    headerBytes.set(afterLen, 0);
    headerBytes.set(head, afterLen.length);
    leftover = rest;
  }

  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as FileHeader;

  const plaintext = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover.length > 0) controller.enqueue(leftover);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { header, plaintext };
}

// --- password wrapping of the per-file key -----------------------------------
// The key is small, so we wrap it in one shot (no streaming) with age's scrypt
// passphrase recipient and store the armored ASCII blob.
const KEY_ENC = new TextEncoder();
const KEY_DEC = new TextDecoder();

/** Encrypt a per-file key with a password; returns an armored ASCII blob. */
export async function wrapKey(key: string, password: string): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(password);
  const blob = await encrypter.encrypt(KEY_ENC.encode(key));
  return Buffer.from(blob).toString("base64");
}

/** Recover a per-file key from a wrapped blob; throws on the wrong password. */
export async function unwrapKey(
  wrapped: string,
  password: string,
): Promise<string> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(password);
  const blob = new Uint8Array(Buffer.from(wrapped, "base64"));
  const out = await decrypter.decrypt(blob);
  return KEY_DEC.decode(out);
}
