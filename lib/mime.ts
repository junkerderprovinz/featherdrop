// Map a filename's extension to a content type for the inert types we preview.
// Used as a fallback at finalize time when the uploader's browser supplied no
// (or an empty) content type — otherwise an image/PDF would never preview, since
// both the preview gate and the inline Content-Type key off a known MIME. Mirrors
// lib/preview.ts' allowlist; anything unknown returns null (generic binary).
const BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  pdf: "application/pdf",
};

/** Content type inferred from a filename's extension, or null when unknown. */
export function mimeFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? null;
}
