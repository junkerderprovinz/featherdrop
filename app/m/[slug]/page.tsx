import { ManageView } from "@/components/ManageView";

// The management page is a thin shell: it renders the client view, which reads
// the secret delete token from the URL #fragment (#t=…) in the browser and never
// sends it to the server on navigation. We deliberately do NOT look up the share
// here — the page must render the same markup for any slug (existing, expired or
// unknown) so it leaks nothing, and the token-gated GET/DELETE on
// /api/m/[slug] is the only thing that can confirm a share exists.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function ManagePage({
  params,
}: {
  params: { slug: string };
}) {
  return <ManageView slug={params.slug} />;
}
