// Loads a share's metadata from /api/d/{slug}/meta and renders DownloadView. A
// 404, for a missing, expired or format 1 share, shows the not-found view.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import { DownloadView } from "@/components/DownloadView";
import NotFound from "@/app/not-found";

// The body of server-go/internal/api/meta.go.
interface ShareMeta {
  format: number;
  size: number;
  expiresAt: number | null;
  hasPassword: boolean;
  downloadsLeft: number | null;
  wrappedKey: string | null; // base64
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
  // Name and type are inside the encrypted blob, and link and server mode
  // belong to format 1.
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
