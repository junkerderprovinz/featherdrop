// Upload orchestration: encrypt → OPFS scratch → tus upload → finalize.
// This module is the glue the UI calls; it has no DOM/network dependencies of
// its own — those are injected via UploadDeps so the flow is unit-testable.

import { encryptForUpload } from "./pipeline";
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
  format: 2;
  /** base64-encoded wrapped content key (password mode only). */
  wrappedKey?: string;
  /** base64-encoded KDF salt (password mode only). */
  kdfSalt?: string;
}

export interface UploadDeps {
  /** Upload a File (e.g. via tus). Resolves to the server-assigned upload ID. */
  upload(file: File, onProgress: (sent: number, total: number) => void): Promise<string>;
  /** POST /api/finalize. Resolves to the slug for the share URL. */
  finalize(body: FinalizeRequest): Promise<{ slug: string }>;
  /** Base URL (no trailing slash), e.g. "https://drop.example.tld". */
  baseUrl: string;
}

/**
 * Encrypt a file and upload it to the server.
 *
 * Phases:
 *  1. "encrypting" — stream the file through the E2E pipeline into OPFS scratch.
 *  2. "uploading"  — tus-upload the scratch file; report progress via onPhase.
 *  3. Finalize and return the share URL.
 *
 * The scratch file is always cleaned up (try/finally), even on error.
 */
export async function uploadEncrypted(
  file: File,
  opts: { expiry: string; maxDownloads: number | null; password?: string },
  deps: UploadDeps,
  onPhase?: (phase: "encrypting" | "uploading", fraction: number) => void,
): Promise<{ shareUrl: string }> {
  // Phase 1: encrypt.
  onPhase?.("encrypting", 0);
  const { blob, keyForUrl, wrapped } = await encryptForUpload(
    streamToAsyncIterable(file.stream()),
    { name: file.name, type: file.type },
    opts.password ? { password: opts.password } : undefined,
  );
  onPhase?.("encrypting", 1);

  // Give tus a sliceable source for the encrypted blob. Prefer OPFS (disk-backed,
  // any size); fall back to an in-memory File when OPFS is unavailable — e.g. on
  // plain HTTP, which exposes no navigator.storage. The in-memory path is capped
  // so a huge file can't exhaust the tab; point such users at the HTTPS address.
  let scratchFile: File;
  let cleanup: () => Promise<void>;
  if (canUseOpfs()) {
    ({ file: scratchFile, cleanup } = await writeScratch(blob));
  } else {
    if (file.size > MEMORY_FALLBACK_MAX_BYTES) {
      throw new Error(
        "This file is too large to encrypt without OPFS. Open featherdrop over " +
          "HTTPS (a secure context), or choose a file under 500 MB.",
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
    // key + salt (base64); in link mode they are omitted.
    const body: FinalizeRequest = {
      uploadId,
      expiry: opts.expiry,
      maxDownloads: opts.maxDownloads,
      format: 2,
    };
    if (wrapped) {
      // Standard base64 (btoa) matches what the server expects for binary blobs.
      body.wrappedKey = btoa(String.fromCharCode(...wrapped.wrapped));
      body.kdfSalt = btoa(String.fromCharCode(...wrapped.salt));
    }

    const { slug } = await deps.finalize(body);

    // Build the share URL.
    // Link mode:    https://…/d/<slug>#k=<key>   (key in fragment, never sent to server)
    // Password mode: https://…/d/<slug>           (no fragment — key derived from password)
    const shareUrl =
      keyForUrl ? `${deps.baseUrl}/d/${slug}#k=${keyForUrl}` : `${deps.baseUrl}/d/${slug}`;

    return { shareUrl };
  } finally {
    await cleanup();
  }
}
