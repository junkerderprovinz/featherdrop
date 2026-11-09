// Upload orchestration: encrypt, upload with tus, finalize. Formats 2 and 3
// encrypt into scratch storage first; format 4 encrypts each tus request's
// bytes as it is sent. Network access is injected through UploadDeps for tests.

import { encryptForUpload, type EncryptResult } from "./pipeline";
import { encryptFilesForUpload } from "./multi-pipeline";
import { type PackFile } from "./multi-file";
import { createEncryptor, blobSource } from "./v2/share";
import { writeScratch, writeMemoryScratch, canUseOpfs } from "./opfs-scratch";
import { streamToAsyncIterable } from "./stream-adapters";
import { createManageToken, manageUrl } from "./manage-link";

// Without OPFS, on plain HTTP, the encrypted blob of formats 2 and 3 sits in
// memory, so that path is capped to keep the tab alive.
const MEMORY_FALLBACK_MAX_BYTES = 500 * 1024 * 1024;

export interface FinalizeRequest {
  uploadId: string;
  expiry: string;
  maxDownloads: number | null;
  /**
   * 2 for a single file, 3 for a multi-file manifest blob, 4 for the v2
   * container, which hides the kind inside the encrypted header.
   */
  format: 2 | 3 | 4;
  /** Password mode: the wrapped content key in base64. */
  wrappedKey?: string;
  /** Password mode: the KDF salt in base64. */
  kdfSalt?: string;
  /**
   * Proof of the key: base64url(SHA-256(content key)) for formats 2 and 3, a
   * key-schedule subkey for format 4. The server requires the same value
   * before counting a download, so a leaked slug alone cannot burn the share.
   */
  keyVerifier: string;
  /** base64url(SHA-256(manage token)); the token itself stays in the link. */
  manageTokenHash: string;
}

/** The bytes to upload: an exact length, declared before the first byte, and its slices. */
export interface UploadSource {
  readonly size: number;
  /** The bytes [start, end), cut at size. */
  slice(start: number, end: number): Promise<Blob | Uint8Array>;
}

export interface UploadDeps {
  /** Uploads the source and resolves to the server's upload id. */
  upload(source: UploadSource, opts: { onProgress: (sent: number, total: number) => void }): Promise<string>;
  /** POST /api/finalize, resolving to the share slug. */
  finalize(body: FinalizeRequest): Promise<{ slug: string }>;
  /** Base URL without a trailing slash, e.g. "https://drop.example.tld". */
  baseUrl: string;
}

function packFiles(files: File[]): PackFile[] {
  return files.map((f) => ({
    name: f.name,
    type: f.type || "application/octet-stream",
    size: f.size,
    stream: () => streamToAsyncIterable(f.stream()),
  }));
}

/**
 * Encrypts files and uploads them under one share link. A single file becomes
 * format 2 and keeps the inline preview; several files are packed into one
 * format 3 blob and unpacked on download. With opts.format 4 either becomes a
 * v2 container (./v2/share.ts), encrypted while it uploads, so it needs no
 * scratch copy and reports only the "uploading" phase. Besides the share link
 * it returns the uploader's management link, which deletes the share. A
 * scratch file is removed even when the upload fails.
 */
export async function uploadEncrypted(
  files: File[],
  opts: { expiry: string; maxDownloads: number | null; password?: string; format?: 4 },
  deps: UploadDeps,
  onPhase?: (phase: "encrypting" | "uploading", fraction: number) => void,
): Promise<{ shareUrl: string; manageUrl: string }> {
  if (files.length === 0) throw new Error("uploadEncrypted: no files given");

  if (opts.format === 4) {
    // A password here is a second factor next to the link token, so unlike
    // the older password mode the server stores no wrapped key.
    const enc = await createEncryptor(
      files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      { password: opts.password || undefined },
    );
    const source = blobSource(enc.state, readFiles(files));
    const uploadId = await send(source, deps, onPhase);
    const fields = { expiry: opts.expiry, maxDownloads: opts.maxDownloads, format: 4 as const, keyVerifier: enc.verifier };
    return finish(uploadId, fields, enc.token, deps);
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  onPhase?.("encrypting", 0);
  const password = opts.password ? { password: opts.password } : undefined;
  let result: EncryptResult;
  let format: 2 | 3;
  if (files.length === 1) {
    const file = files[0];
    result = await encryptForUpload(
      streamToAsyncIterable(file.stream()),
      // The encrypted size lets the video preview do exact Range math without
      // relying on the ciphertext size the server sees.
      { name: file.name, type: file.type, size: file.size },
      // New shares are seekable so large videos can seek in the preview.
      { ...password, seekable: true },
    );
    format = 2;
  } else {
    result = await encryptFilesForUpload(packFiles(files), password);
    format = 3;
  }
  const { blob, keyForUrl, wrapped, keyVerifier } = result;
  onPhase?.("encrypting", 1);

  // tus needs a sliceable source. OPFS is disk-backed and has no size limit;
  // without it the blob is held in memory.
  let scratchFile: File;
  let cleanup: () => Promise<void>;
  if (canUseOpfs()) {
    ({ file: scratchFile, cleanup } = await writeScratch(blob));
  } else {
    if (totalSize > MEMORY_FALLBACK_MAX_BYTES) {
      throw new Error(
        "These files are too large to encrypt without OPFS. Open featherdrop over " +
          "HTTPS (a secure context), or choose files under 500 MB total.",
      );
    }
    ({ file: scratchFile, cleanup } = await writeMemoryScratch(blob));
  }

  try {
    const source: UploadSource = {
      size: scratchFile.size,
      slice: async (start, end) => scratchFile.slice(start, end),
    };
    const uploadId = await send(source, deps, onPhase);
    const fields: FinalizeFields = { expiry: opts.expiry, maxDownloads: opts.maxDownloads, format, keyVerifier };
    if (wrapped) {
      fields.wrappedKey = btoa(String.fromCharCode(...wrapped.wrapped));
      fields.kdfSalt = btoa(String.fromCharCode(...wrapped.salt));
    }
    return await finish(uploadId, fields, keyForUrl, deps);
  } finally {
    await cleanup();
  }
}

/** Reads the plaintext range [start, end) of the files laid end to end. */
function readFiles(files: Blob[]): (start: number, end: number) => Promise<Uint8Array> {
  return async (start, end) => {
    const parts: Blob[] = [];
    let base = 0;
    for (const f of files) {
      const a = Math.max(start, base);
      const b = Math.min(end, base + f.size);
      if (b > a) parts.push(f.slice(a - base, b - base));
      base += f.size;
    }
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  };
}

async function send(
  source: UploadSource,
  deps: UploadDeps,
  onPhase?: (phase: "encrypting" | "uploading", fraction: number) => void,
): Promise<string> {
  onPhase?.("uploading", 0);
  const uploadId = await deps.upload(source, {
    onProgress: (sent, total) => onPhase?.("uploading", total > 0 ? sent / total : 0),
  });
  onPhase?.("uploading", 1);
  return uploadId;
}

type FinalizeFields = Omit<FinalizeRequest, "uploadId" | "manageTokenHash">;

async function finish(
  uploadId: string,
  fields: FinalizeFields,
  keyForUrl: string,
  deps: UploadDeps,
): Promise<{ shareUrl: string; manageUrl: string }> {
  const manage = await createManageToken();
  const { slug } = await deps.finalize({ uploadId, ...fields, manageTokenHash: manage.hash });

  // In link mode the key rides in the fragment, which never reaches the
  // server; in the older password mode the link carries no key.
  const shareUrl = keyForUrl ? `${deps.baseUrl}/d/${slug}#k=${keyForUrl}` : `${deps.baseUrl}/d/${slug}`;

  return { shareUrl, manageUrl: manageUrl(deps.baseUrl, slug, manage.token) };
}
