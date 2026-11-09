// Encrypted notes: a format 4 share of kind "text" whose content is the note in
// UTF-8. The kind lives in the encrypted header and the content is padded like
// any file, so the server cannot tell a note from a small file. A note is
// decoded as text and never interpreted as markup.

import { TEXT_TYPE, type Header } from "./v2/layout";
import type { ShareKeys } from "./v2/token";
import type { Client } from "./v2/protocol";
import { decryptInWorker } from "./v2/remote";
import { sendV2, type UploadDeps } from "./upload-flow";

export const NOTE_TYPE = TEXT_TYPE;

/** Notes are read into memory whole, so they are kept small. */
export const MAX_NOTE_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

/** The note as share content: its UTF-8 bytes and the header entry for them. */
export function noteContent(text: string): { bytes: Uint8Array<ArrayBuffer>; entry: { name: string; type: string; size: number } } {
  if (text.length === 0) throw new Error("note: the note is empty");
  const bytes = utf8.encode(text);
  if (bytes.length > MAX_NOTE_BYTES) throw new Error("note: the note is too long");
  return { bytes, entry: { name: "", type: NOTE_TYPE, size: bytes.length } };
}

/**
 * Encrypts a note and shares it like a file, with the same expiry, download
 * limit and optional password. Returns the share link and the management
 * link.
 */
export async function uploadNote(
  text: string,
  opts: { expiry: string; maxDownloads: number | null; password?: string },
  deps: UploadDeps,
): Promise<{ shareUrl: string; manageUrl: string }> {
  const { bytes, entry } = noteContent(text);
  const { token, verifier, state } = await deps.crypto.request({
    op: "create",
    files: [entry],
    password: opts.password || undefined,
    kind: "text",
  });
  return sendV2(
    { token, verifier, blob: state, files: [], expiry: opts.expiry, maxDownloads: opts.maxDownloads },
    [new Blob([bytes])],
    { id: null, uploadUrl: null },
    deps,
  );
}

/** Reads the plaintext of a text share whose header is already open. */
export async function noteText(header: Header, plaintext: AsyncIterable<Uint8Array>): Promise<string> {
  if (header.kind !== "text") throw new Error("note: this share is not a note");
  if (header.size > MAX_NOTE_BYTES) throw new Error("note: the note is too long");
  const parts: Uint8Array[] = [];
  for await (const part of plaintext) parts.push(part);
  const bytes = new Uint8Array(header.size);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Downloads and decrypts a note. The download counts like any other, so a
 * once-only note is gone after this. Fails for a share that is not a note.
 */
export async function readNote(
  crypto: Client,
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: { token: string; password?: string } | { keys: ShareKeys },
): Promise<string> {
  const { header, plaintext } = await decryptInWorker(crypto, secret, fetchBlob);
  return noteText(header, plaintext);
}
