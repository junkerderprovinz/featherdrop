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

  // For encrypted link-mode shares the server never sees the real name (it is
  // inside the encrypted header); the client reveals it after decrypting with
  // the #key fragment. For password mode it is revealed after the password POST.
  // original_name holds the plaintext name only for legacy unencrypted blobs.
  const linkMode = rec.encrypted === 1 && rec.enc_mode === "link";
  const serverName = rec.encrypted === 1 ? null : rec.original_name;

  return (
    <DownloadView
      slug={rec.slug}
      name={serverName}
      size={rec.size}
      expiresAt={rec.expires_at}
      hasPassword={rec.password_hash !== null}
      linkMode={linkMode}
    />
  );
}
