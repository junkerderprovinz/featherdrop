// Build the public share link for an uploaded file.
//
// Prefer the operator-configured BASE_URL (set behind a reverse proxy / custom
// domain) over the browser's current origin, so the link always uses the public
// domain no matter how the uploader reached the page (internal IP, DNS name,
// tailnet address). When BASE_URL is empty, fall back to the browser origin.
//
// The per-file decryption key (when present) rides in the URL fragment (#k=…)
// and is never sent to the server. In server master-key mode there is no key in
// the URL, so the fragment is omitted.
export function buildShareUrl(
  baseUrl: string,
  origin: string,
  slug: string | null | undefined,
  linkKey: string | null | undefined,
): string {
  if (!slug) return "";
  const base = (baseUrl || origin).replace(/\/+$/, "");
  const fragment = linkKey ? `#k=${linkKey}` : "";
  return `${base}/d/${slug}${fragment}`;
}
