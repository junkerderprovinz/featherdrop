// Whether a tus upload has fully arrived, judged from the ACTUAL bytes on disk
// against the declared total length.
//
// Why not the sidecar's `offset`? @tus/file-store writes the `<id>.json` sidecar
// with `offset` only at creation (= 0) and never updates it per write — it tracks
// progress via the live file size instead (getUpload returns offset = stat.size).
// So the sidecar's `offset` stays 0 even for a complete upload; trusting it makes
// finalize reject every non-empty file with a false "upload not complete" (409).
//
// `declaredSize` is the sidecar's `size` (Upload-Length). When it is unknown
// (deferred length / not a number) we cannot prove incompleteness, so we accept.
export function isUploadComplete(
  actualSize: number,
  declaredSize: number | null | undefined,
): boolean {
  if (typeof declaredSize !== "number") return true;
  return actualSize >= declaredSize;
}
