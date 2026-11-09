// The tus side of an upload. tus reads the source through a custom file
// reader, so a source that produces its bytes on demand, such as a format 4
// blob encrypted per request, uploads like a file on disk.

import * as tus from "tus-js-client";
import type { UploadSource } from "./upload-flow";

// Without chunking the whole blob goes in one request, which a proxy with a
// 100 MB cap such as Cloudflare rejects with 413, and a dropped upload
// restarts from zero.
const CHUNK_SIZE = 64 * 1024 * 1024;

function sourceReader(source: UploadSource) {
  return {
    async openFile() {
      return {
        size: source.size,
        async slice(start: number, end: number) {
          const stop = Math.min(end, source.size);
          const part = await source.slice(start, stop);
          // tus measures a slice by its size property, which only a Blob has.
          const value = part instanceof Blob ? part : new Blob([part as Uint8Array<ArrayBuffer>]);
          return { value, done: stop >= source.size };
        },
        close() {},
      };
    },
  };
}

/** Uploads source and resolves to the server's upload id, the last segment of the upload URL. */
export function tusUpload(
  source: UploadSource,
  opts: {
    endpoint?: string;
    headers?: Record<string, string>;
    chunkSize?: number;
    onProgress?: (sent: number, total: number) => void;
  } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const upload = new tus.Upload(source as unknown as Blob, {
      endpoint: opts.endpoint ?? "/files",
      fileReader: sourceReader(source),
      uploadSize: source.size,
      chunkSize: opts.chunkSize ?? CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000],
      headers: opts.headers ?? {},
      // No fingerprint: nothing about the upload goes to localStorage.
      fingerprint: async () => "",
      storeFingerprintForResuming: false,
      // No metadata: name and type are encrypted inside the blob.
      onError: reject,
      onProgress: opts.onProgress ?? null,
      onSuccess: () => {
        const id = upload.url?.split("/").pop();
        if (id) resolve(id);
        else reject(new Error("tus upload missing URL"));
      },
    });
    upload.start();
  });
}
