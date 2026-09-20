// The configured BASE_URL wins over the browser's origin, so the link uses the
// public domain however the uploader reached the page (internal IP, DNS name,
// tailnet address). The key, when there is one, rides in the fragment and never
// reaches the server; server master-key mode has none.
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
