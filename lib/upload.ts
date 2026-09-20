// Whether a tus upload has fully arrived, judged by the bytes on disk against
// the declared length. The sidecar's offset cannot be used: the tus file store
// writes it once at creation as 0 and tracks progress by file size, so trusting
// it would reject every non-empty upload as incomplete. An unknown declared
// size, from a deferred length, cannot prove the upload incomplete and passes.
export function isUploadComplete(
  actualSize: number,
  declaredSize: number | null | undefined,
): boolean {
  if (typeof declaredSize !== "number") return true;
  return actualSize >= declaredSize;
}
