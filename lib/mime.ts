// Map a filename's extension to a content type for the types we can preview.
// Used as a fallback at finalize time when the uploader's browser supplied no
// (or an empty) content type — otherwise the file would never preview, since
// both the preview gate and the inline Content-Type key off a known MIME. Mirrors
// lib/preview.ts' allowlist; anything unknown returns null (generic binary).
//
// NOTE: this only assigns a MIME. The server's inline (?inline=1) gate uses the
// STRICTER isServerInlineMime, so an "svg" mapping here still won't be served
// inline by the server (SVG is client-blob-<img>-only). See lib/preview.ts.
const BY_EXT: Record<string, string> = {
  // Images.
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  apng: "image/apng",
  svg: "image/svg+xml",
  // Video.
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  // Audio.
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  oga: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  flac: "audio/flac",
  // Text / code.
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  // Documents.
  pdf: "application/pdf",
};

/** Content type inferred from a filename's extension, or null when unknown. */
export function mimeFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? null;
}
