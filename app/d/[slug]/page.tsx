import { notFound } from "next/navigation";
import { getFileBySlug } from "@/server/db";
import { DownloadView } from "@/components/DownloadView";

// Read the share metadata at request time (never statically). The DB singleton
// lazily initializes, so this is safe whether or not the custom server has
// already opened it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function DownloadPage({
  params,
}: {
  params: { slug: string };
}) {
  const rec = getFileBySlug(params.slug);
  if (!rec || (rec.expires_at !== null && rec.expires_at <= Date.now())) {
    notFound();
  }

  return (
    <DownloadView
      slug={rec.slug}
      name={rec.original_name}
      size={rec.size}
      expiresAt={rec.expires_at}
      hasPassword={rec.password_hash !== null}
    />
  );
}
