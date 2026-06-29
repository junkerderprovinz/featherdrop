// Client replacement for app/d/[slug]/page.tsx.
//
// The Next page read the DB on the server and rendered <DownloadView/> with the
// format>=2 share metadata. The static SPA has no server render, so it FETCHES
// GET /api/d/{slug}/meta — the Go endpoint that returns the exact same shape the
// SSR page computed (format, size, expiresAt, hasPassword, downloadsLeft,
// wrappedKey, kdfSalt; name/mime are zero-knowledge and absent). A 404 (no row,
// expired, or legacy format<2) renders the same not-found view as the Next app.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import { DownloadView } from "@/components/DownloadView";
import NotFound from "@/app/not-found";

// Mirrors the metaResponse the Go server returns (server-go/internal/api/meta.go)
// and the DownloadView props the SSR page passed for a format>=2 share.
interface ShareMeta {
  format: number;
  size: number;
  expiresAt: number | null;
  hasPassword: boolean;
  downloadsLeft: number | null;
  wrappedKey: string | null; // base64 (matches the SSR Buffer.toString("base64"))
  kdfSalt: string | null; // base64
}

type State =
  | { phase: "loading" }
  | { phase: "ready"; meta: ShareMeta }
  | { phase: "notfound" };

export function DownloadPage() {
  const { slug = "" } = useParams();
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const res = await fetch(`/api/d/${encodeURIComponent(slug)}/meta`);
        if (cancelled) return;
        if (!res.ok) {
          setState({ phase: "notfound" });
          return;
        }
        const meta = (await res.json()) as ShareMeta;
        if (cancelled) return;
        setState({ phase: "ready", meta });
      } catch {
        if (!cancelled) setState({ phase: "notfound" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.phase === "loading") {
    return (
      <Center style={{ minHeight: "100vh" }}>
        <Loader />
      </Center>
    );
  }

  if (state.phase === "notfound") {
    return <NotFound />;
  }

  const { meta } = state;
  // Same props the SSR page (app/d/[slug]/page.tsx) passed for rec.format >= 2:
  // name/mime null (zero-knowledge), linkMode/serverMode false (v2 paths).
  return (
    <DownloadView
      slug={slug}
      name={null}
      size={meta.size}
      mime={null}
      expiresAt={meta.expiresAt}
      hasPassword={meta.hasPassword}
      linkMode={false}
      serverMode={false}
      downloadsLeft={meta.downloadsLeft}
      format={meta.format}
      wrappedKey={meta.wrappedKey}
      kdfSalt={meta.kdfSalt}
    />
  );
}
