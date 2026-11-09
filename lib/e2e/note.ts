// Encrypted notes: a format 4 share of kind "text" whose content is the note in
// UTF-8. The kind lives in the encrypted header and the content is padded like
// any file, so the server cannot tell a note from a small file. A note is
// decoded as text and never interpreted as markup.

import { createEncryptor, decryptShare, openKeys, TEXT_TYPE, type Header } from "./v2/share";
import type { ShareKeys } from "./v2/keys";
import { writeMemoryScratch } from "./opfs-scratch";
import { streamToAsyncIterable } from "./stream-adapters";
import { createManageToken, manageUrl } from "./manage-link";
import type { UploadDeps } from "./upload-flow";

export const NOTE_TYPE = TEXT_TYPE;

/** Notes are read into memory whole, so they are kept small. */
export const MAX_NOTE_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

/** The note as share content: its UTF-8 bytes and the header entry for them. */
export function noteContent(text: string): { bytes: Uint8Array; entry: { name: string; type: string; size: number } } {
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
  const enc = await createEncryptor([entry], { password: opts.password || undefined, kind: "text" });
  const blob = (async function* () {
    yield enc.prefix;
    yield* enc.push(bytes);
    yield* enc.finish();
  })();
  const { file } = await writeMemoryScratch(blob);
  const uploadId = await deps.upload(file, () => {});
  const manage = await createManageToken();
  const { slug } = await deps.finalize({
    uploadId,
    expiry: opts.expiry,
    maxDownloads: opts.maxDownloads,
    format: 4,
    keyVerifier: enc.verifier,
    manageTokenHash: manage.hash,
  });
  return {
    shareUrl: `${deps.baseUrl}/d/${slug}#k=${enc.token}`,
    manageUrl: manageUrl(deps.baseUrl, slug, manage.token),
  };
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
  fetchBlob: (keyVerifier: string) => Promise<ReadableStream<Uint8Array>>,
  secret: { token: string; password?: string } | { keys: ShareKeys },
): Promise<string> {
  const keys = "keys" in secret ? secret.keys : await openKeys(secret.token, secret.password);
  const stream = await fetchBlob(keys.verifier);
  const { header, plaintext } = await decryptShare(streamToAsyncIterable(stream), keys);
  return noteText(header, plaintext);
}
