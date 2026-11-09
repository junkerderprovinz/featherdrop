// The content types the download page may preview inline. The preview
// decrypts in the browser and renders a blob: URL in an inert element (<img>,
// <video controls>, <audio controls>, <embed>, <pre>); the type comes from the
// uploader, so anything scriptable stays off the list.

export type PreviewKind = "image" | "video" | "pdf" | "audio" | "text";

// An SVG in an <img> runs no scripts, so SVG is only safe here as long as
// PreviewArea renders it through <img> and never through <embed>, <iframe>,
// <object> or inline markup.
const PREVIEW_KINDS: Record<string, PreviewKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "image/bmp": "image",
  "image/x-icon": "image",
  "image/vnd.microsoft.icon": "image",
  "image/apng": "image",
  "image/svg+xml": "image",
  // A <video> only plays what the browser can decode: mp4, webm, ogg and mov
  // play reliably, mkv only with VP8/9 or AV1. Most browsers cannot decode
  // avi, wmv, flv, mpeg or 3gp and show an inert player that does not start.
  "video/mp4": "video",
  "video/webm": "video",
  "video/ogg": "video",
  "video/quicktime": "video", // .mov
  "video/x-m4v": "video", // .m4v
  "video/x-matroska": "video", // .mkv (plays only with browser-supported codecs)
  "video/mkv": "video", // some uploaders/browsers report .mkv as video/mkv
  "video/x-msvideo": "video", // .avi (often not browser-decodable)
  "video/avi": "video", // .avi (alt MIME)
  "video/msvideo": "video", // .avi (alt MIME)
  "video/mpeg": "video", // .mpg / .mpeg
  "video/3gpp": "video", // .3gp
  "video/3gpp2": "video", // .3g2
  "video/x-ms-wmv": "video", // .wmv (rarely browser-decodable)
  "video/x-flv": "video", // .flv (rarely browser-decodable)
  "video/mp2t": "video", // .ts / .m2ts (MPEG transport stream)
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/aac": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/flac": "audio",
  "audio/webm": "audio",
  "audio/opus": "audio",
  // Text renders as escaped React children in a <pre>, never as HTML, and
  // Markdown shows as raw text.
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text",
  "application/xml": "text",
  "text/xml": "text",
  "application/x-yaml": "text",
  "text/yaml": "text",
  "application/pdf": "pdf",
};

// Lower-cases a content type and drops its parameters.
function baseMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const base = mime.split(";")[0].trim().toLowerCase();
  return base.length > 0 ? base : null;
}

/**
 * The preview kind for a content type, or null for unknown, generic and
 * scriptable types such as HTML. Case and parameters are ignored.
 */
export function previewKind(mime: string | null | undefined): PreviewKind | null {
  const base = baseMime(mime);
  if (!base) return null;
  return PREVIEW_KINDS[base] ?? null;
}

/** Whether a content type may be previewed from a client-side blob. */
export function isPreviewableMime(mime: string | null | undefined): boolean {
  return previewKind(mime) !== null;
}
