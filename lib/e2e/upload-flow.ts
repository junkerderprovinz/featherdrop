// Upload orchestration: encrypt → OPFS scratch → tus upload → finalize.
// This module is the glue the UI calls; it has no DOM/network dependencies of
// its own — those are injected via UploadDeps so the flow is unit-testable.

import { encryptForUpload, type EncryptResult } from "./pipeline";
import { encryptFilesForUpload } from "./multi-pipeline";
import type { PackFile } from "./multi-file";
import { writeScratch, writeMemoryScratch, canUseOpfs } from "./opfs-scratch";
import { streamToAsyncIterable } from "./stream-adapters";

// Without OPFS (e.g. on plain HTTP) the encrypted blob is buffered in memory, so
// cap the original file size on that path to avoid exhausting the tab's memory.
// OPFS (the secure-context path) is disk-backed and has no such limit.
const MEMORY_FALLBACK_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export interface FinalizeRequest {
  uploadId: string;
  expiry: string;
  maxDownloads: number | null;
  /** 2 = single file (legacy zero-knowledge); 3 = multi-file manifest blob. */
  format: 2 | 3;
  /** base64-encoded wrapped content key (password mode only). */
  wrappedKey?: string;
  /** base64-encoded KDF salt (password mode only). */
  kdfSalt?: string;
  /**
   * base64url(SHA-256(content key)) — the server stores it and requires the
   * same value (header `x-fd-key-verifier`) before counting a download, so a
   * leaked slug alone can't burn the share. One-way; reveals nothing about K.
   */
  keyVerifier: string;
}

export interface UploadDeps {
  /** Upload a File (e.g. via tus). Resolves to the server-assigned upload ID. */
  upload(file: File, onProgress: (sent: number, total: number) => void): Promise<string>;
  /**
   * POST /api/finalize. Resolves to the slug for the share URL and the raw
   * manage token (the uploader's "delete early" credential). `manageToken` is
   * absent only for legacy servers that predate the management-link feature.
   */
  finalize(body: FinalizeRequest): Promise<{ slug: string; manageToken?: string }>;
  /** Base URL (no trailing slash), e.g. "https://drop.example.tld". */
  baseUrl: string;
}

/**
 * Encrypt one or more files and upload them to the server under ONE share link.
 *
 * - Exactly 1 file  → format 2 (the legacy single-file path; bytes + FileMeta).
 *   Inline preview on download is preserved — this path is byte-for-byte
 *   identical to before.
 * - 2+ files        → format 3 (the multi-file manifest path): the files are
 *   packed into one opaque blob (manifest + concatenated bytes) and unpacked
 *   client-side on download. Still one slug, one key, one link.
 *
 * Phases:
 *  1. "encrypting" — stream the file(s) through the E2E pipeline into OPFS scratch.
 *  2. "uploading"  — tus-upload the scratch file; report progress via onPhase.
 *  3. Finalize and return the share URL.
 *
 * The scratch file is always cleaned up (try/finally), even on error.
 */
export async function uploadEncrypted(
  files: File[],
  opts: { expiry: string; maxDownloads: number | null; password?: string },
  deps: UploadDeps,
  onPhase?: (phase: "encrypting" | "uploading", fraction: number) => void,
): Promise<{ shareUrl: string; manageUrl?: string }> {
  if (files.length === 0) throw new Error("uploadEncrypted: no files given");

  // The combined plaintext size — what the in-memory fallback cap applies to.
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  // Phase 1: encrypt. One file uses the single-file pipeline (format 2,
  // untouched); several use the multi-file pipeline (format 3). Both yield the
  // same EncryptResult shape, so the OPFS/tus/finalize tail below is shared.
  onPhase?.("encrypting", 0);
  const password = opts.password ? { password: opts.password } : undefined;
  let result: EncryptResult;
  let format: 2 | 3;
  if (files.length === 1) {
    const file = files[0];
    result = await encryptForUpload(
      streamToAsyncIterable(file.stream()),
      // `size` (plaintext byte length) is embedded in the client-encrypted
      // enc_meta so the download page can do exact Range math for the streaming
      // large-video preview without trusting the server-visible ciphertext size.
      // It stays inside the ZK envelope — the server never sees it.
      { name: file.name, type: file.type, size: file.size },
      // Every NEW single-file share is cf=2 (seekable per-chunk AEAD) so large
      // videos get TRUE random-access seeking in the streaming preview. The cf=2
      // selector + baseNonce live inside enc_meta (zero-knowledge); old cf=1
      // shares still decrypt via the secretstream path. password is forwarded.
      { ...password, seekable: true },
    );
    format = 2;
  } else {
    const packFiles: PackFile[] = files.map((f) => ({
      name: f.name,
      type: f.type || "application/octet-stream",
      size: f.size,
      stream: () => streamToAsyncIterable(f.stream()),
    }));
    result = await encryptFilesForUpload(packFiles, password);
    format = 3;
  }
  const { blob, keyForUrl, wrapped, keyVerifier } = result;
  onPhase?.("encrypting", 1);

  // Give tus a sliceable source for the encrypted blob. Prefer OPFS (disk-backed,
  // any size); fall back to an in-memory File when OPFS is unavailable — e.g. on
  // plain HTTP, which exposes no navigator.storage. The in-memory path is capped
  // so a huge bundle can't exhaust the tab; point such users at the HTTPS address.
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
    // Phase 2: upload.
    onPhase?.("uploading", 0);
    const uploadId = await deps.upload(scratchFile, (sent, total) => {
      onPhase?.("uploading", total > 0 ? sent / total : 0);
    });
    onPhase?.("uploading", 1);

    // Build the finalize body.  In password mode the server stores the wrapped
    // key + salt (base64); in link mode they are omitted. The key verifier is
    // always sent — it lets the server demand proof of key knowledge before
    // counting a download (see FinalizeRequest.keyVerifier).
    const body: FinalizeRequest = {
      uploadId,
      expiry: opts.expiry,
      maxDownloads: opts.maxDownloads,
      format,
      keyVerifier,
    };
    if (wrapped) {
      // Standard base64 (btoa) matches what the server expects for binary blobs.
      body.wrappedKey = btoa(String.fromCharCode(...wrapped.wrapped));
      body.kdfSalt = btoa(String.fromCharCode(...wrapped.salt));
    }

    const { slug, manageToken } = await deps.finalize(body);

    // Build the share URL.
    // Link mode:    https://…/d/<slug>#k=<key>   (key in fragment, never sent to server)
    // Password mode: https://…/d/<slug>           (no fragment — key derived from password)
    const shareUrl =
      keyForUrl ? `${deps.baseUrl}/d/${slug}#k=${keyForUrl}` : `${deps.baseUrl}/d/${slug}`;

    // Build the management URL. The manage token lives in the URL #fragment
    // (#t=<token>), exactly like the content key, so it is never sent to the
    // server on navigation and never appears in access logs. The DELETE request
    // later reads it from the fragment and sends it via the x-fd-manage-token
    // header. Absent only for legacy servers that don't return a manageToken.
    const manageUrl = manageToken
      ? `${deps.baseUrl}/m/${slug}#t=${manageToken}`
      : undefined;

    return { shareUrl, manageUrl };
  } finally {
    await cleanup();
  }
}
