// Allowlist of content types that are safe to render inline in the browser from
// our own origin. Deliberately EXCLUDES image/svg+xml and any HTML/XML type —
// those can carry <script> and would be a stored-XSS vector when served with
// Content-Disposition: inline. Raster images and PDF are inert.
//
// The MIME is uploader-controlled (tus metadata), so the SERVER must enforce
// this allowlist on the inline response — the client preview gate is not enough,
// because the inline GET is reachable directly.
const PREVIEWABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export function isPreviewableMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const base = mime.split(";")[0].trim().toLowerCase();
  return PREVIEWABLE.has(base);
}
