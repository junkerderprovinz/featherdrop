// Allowlist of content types that may be rendered as an inline preview on the
// download page. Two distinct surfaces consume this module, with DIFFERENT trust
// rules — keep them straight:
//
//   1. CLIENT blob: preview (DownloadView's PreviewArea). The plaintext is
//      decrypted in the browser and rendered from a blob: URL inside an INERT
//      element (<img>/<video controls>/<audio controls>/<embed>/<pre>). This is
//      what previewKind() / isPreviewableMime() describe.
//
//   2. SERVER inline response (v1 ?inline=1 in app/api/d/[slug]/route.ts), which
//      streams the file's own bytes with the uploader-controlled MIME +
//      Content-Disposition: inline. Navigating directly to that URL renders the
//      response as a TOP-LEVEL document, so a scriptable type (SVG/HTML/XML) is
//      stored-XSS on our origin. The server therefore uses the STRICTER
//      isServerInlineMime() below, which excludes SVG. NEVER point the server at
//      isPreviewableMime — it would serve image/svg+xml inline and run scripts.
//
// The MIME is uploader-controlled (tus metadata / decrypted header), so any
// inline server response MUST enforce its allowlist itself — the client gate is
// not enough, the inline GET is attacker-reachable directly.

// What kind of inline preview a content type maps to (or null if not previewable).
export type PreviewKind = "image" | "video" | "pdf" | "audio" | "text";

// Base MIME → preview kind. Only types we can render INERTLY in the browser.
//
// SVG SAFETY: image/svg+xml is included as "image" because an SVG referenced by
// an <img> element runs NO scripts (browser "secure static mode"). It is ONLY
// ever safe here when rendered via <img> — never via <embed>/<iframe>/<object>
// or inlined into the DOM, and never served inline by the server (see
// isServerInlineMime, which deliberately omits it). Do not change the SVG render
// path in PreviewArea away from <img>.
const PREVIEW_KINDS: Record<string, PreviewKind> = {
  // Raster images — rendered via <img> (no scripting surface).
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "image/bmp": "image",
  "image/x-icon": "image",
  "image/vnd.microsoft.icon": "image",
  "image/apng": "image",
  // SVG — safe ONLY via <img> (see SVG SAFETY note above). Never inline/embed it.
  "image/svg+xml": "image",
  // Video containers the <video> element can play; rendered from a blob: URL.
  // mkv (Matroska) is included on request, but browsers only DECODE it when the
  // inner codecs are supported (VP8/VP9/AV1 + Vorbis/Opus); an mkv with
  // H.264/HEVC+AC3 shows a non-playing <video> (inert, never unsafe). avi stays
  // omitted (rarely playable). Keep this list to containers browsers can play.
  "video/mp4": "video",
  "video/webm": "video",
  "video/ogg": "video",
  "video/quicktime": "video", // .mov
  "video/x-m4v": "video", // .m4v
  "video/x-matroska": "video", // .mkv (plays only with browser-supported codecs)
  "video/mkv": "video", // some uploaders/browsers report .mkv as video/mkv
  // Audio containers the <audio> element can play; rendered from a blob: URL.
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/aac": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/flac": "audio",
  "audio/webm": "audio",
  "audio/opus": "audio",
  // Plain text / code — decrypted, UTF-8 decoded and rendered as ESCAPED React
  // text children in a <pre> (never as HTML). Markdown is shown as raw text on
  // purpose; rich Markdown rendering is a deliberate later feature.
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text",
  "application/xml": "text",
  "text/xml": "text",
  "application/x-yaml": "text",
  "text/yaml": "text",
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
 * previewed (unknown / generic / scriptable types like HTML). SVG maps to
 * "image" because the client renders it via an inert <img>; see the SVG SAFETY
 * note above. Case-insensitive and parameter-tolerant ("image/png; charset=…").
 */
export function previewKind(mime: string | null | undefined): PreviewKind | null {
  const base = baseMime(mime);
  if (!base) return null;
  return PREVIEW_KINDS[base] ?? null;
}

/** Whether a content type may be rendered as a CLIENT blob: preview. */
export function isPreviewableMime(mime: string | null | undefined): boolean {
  return previewKind(mime) !== null;
}

/**
 * Whether the SERVER may stream this type as an inline (?inline=1) response.
 * STRICTER than isPreviewableMime: it excludes image/svg+xml, because an inline
 * server response is rendered as a top-level document and SVG can carry scripts
 * (stored-XSS on our origin). The server-side v1 inline route MUST use this, not
 * isPreviewableMime. (Client blob: previews of SVG remain safe via <img>.)
 */
export function isServerInlineMime(mime: string | null | undefined): boolean {
  const base = baseMime(mime);
  if (!base) return false;
  if (base === "image/svg+xml") return false;
  return PREVIEW_KINDS[base] !== undefined;
}
