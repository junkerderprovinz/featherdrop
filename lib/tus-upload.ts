// The tus upload the pages share. Name and type are encrypted inside the
// blob, so the upload carries no metadata.
import * as tus from "tus-js-client";

export function tusUpload(
  file: File,
  headers: Record<string, string>,
  onProgress: (sent: number, total: number) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: "/files",
      // A proxy with a 100 MB body cap would refuse one request for the whole blob.
      chunkSize: 64 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000],
      headers,
      onError: reject,
      onProgress,
      onSuccess: () => {
        const id = upload.url?.split("/").pop();
        if (id) resolve(id);
        else reject(new Error("tus upload missing URL"));
      },
    });
    upload.start();
  });
}

/** The upload password the upload page keeps for this tab, or "". */
export function storedUploadToken(): string {
  try {
    return sessionStorage.getItem("fd-upload-token") ?? "";
  } catch {
    return "";
  }
}
