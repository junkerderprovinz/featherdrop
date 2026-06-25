// Allowlist of content types that are safe to render inline in the browser from
// our own origin. Deliberately EXCLUDES image/svg+xml and any HTML/XML type —
// those can carry <script> and would be a stored-XSS vector when served with
// Content-Disposition: inline. Raster images, inert video containers and PDF are
// rendered from a decrypted blob: URL (client-side), so they cannot script our
// origin.
//
// The MIME is uploader-controlled (tus metadata), so the SERVER must enforce
// this allowlist on any inline response — the client preview gate is not enough,
// because the inline GET is reachable directly.

// What kind of inline preview a content type maps to (or null if not previewable).
export type PreviewKind = "image" | "video" | "pdf";

// Base MIME → preview kind. Only inert, non-scriptable types appear here.
const PREVIEW_KINDS: Record<string, PreviewKind> = {
  // Raster images (no SVG — it can carry <script>).
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  // Video containers the <video> element can play; rendered from a blob: URL.
  "video/mp4": "video",
  "video/webm": "video",
  "video/ogg": "video",
  // Documents.
  "application/pdf": "pdf",
};

// Normalize a raw content type to its lowercase base (drop parameters/whitespace).
function baseMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const base = mime.split(";")[0].trim().toLowerCase();
  return base.length > 0 ? base : null;
}

/**
 * The inline preview kind for a content type, or null when it must not be
 * previewed inline (unknown / generic / scriptable types like SVG/HTML/XML).
 * Case-insensitive and parameter-tolerant (e.g. "image/png; charset=utf-8").
 */
export function previewKind(mime: string | null | undefined): PreviewKind | null {
  const base = baseMime(mime);
  if (!base) return null;
  return PREVIEW_KINDS[base] ?? null;
}

/** Whether a content type may be rendered inline (image, video or PDF). */
export function isPreviewableMime(mime: string | null | undefined): boolean {
  return previewKind(mime) !== null;
}
