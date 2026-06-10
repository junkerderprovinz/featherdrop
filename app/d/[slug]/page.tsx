import { notFound } from "next/navigation";
import { getFileBySlug } from "@/server/db";
import { downloadsLeft } from "@/lib/downloads";
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

  // -------------------------------------------------------------------------
  // v2 zero-knowledge path: name and MIME are inside the client-encrypted blob
  // and are invisible to the server. The client decrypts them in the browser.
  // -------------------------------------------------------------------------
  if (rec.format === 2) {
    return (
      <DownloadView
        slug={rec.slug}
        name={null}
        size={rec.size}
        mime={null}
        expiresAt={rec.expires_at}
        hasPassword={rec.wrapped_key !== null}
        linkMode={false}
        serverMode={false}
        downloadsLeft={downloadsLeft(rec.download_count, rec.max_downloads)}
        format={2}
        wrappedKey={
          rec.wrapped_key ? Buffer.from(rec.wrapped_key).toString("base64") : null
        }
        kdfSalt={
          rec.kdf_salt ? Buffer.from(rec.kdf_salt).toString("base64") : null
        }
      />
    );
  }

  // -------------------------------------------------------------------------
  // v1 legacy path — unchanged
  // -------------------------------------------------------------------------
  // The real filename is inside the encrypted blob, so the server doesn't know
  // it for any encrypted share — the client reveals it after authorizing:
  //   - link:     decrypt with the #fragment key.
  //   - server:   the server decrypts with its master key (no credential).
  //   - password: revealed after the password POST.
  // original_name holds the plaintext name only for legacy unencrypted blobs.
  const linkMode = rec.encrypted === 1 && rec.enc_mode === "link";
  const serverMode = rec.encrypted === 1 && rec.enc_mode === "server";
  const serverName = rec.encrypted === 1 ? null : rec.original_name;

  return (
    <DownloadView
      slug={rec.slug}
      name={serverName}
      size={rec.size}
      mime={rec.mime}
      expiresAt={rec.expires_at}
      hasPassword={rec.password_hash !== null}
      linkMode={linkMode}
      serverMode={serverMode}
      downloadsLeft={downloadsLeft(rec.download_count, rec.max_downloads)}
    />
  );
}
