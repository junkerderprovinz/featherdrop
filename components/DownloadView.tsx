"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Container,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
  Tooltip,
  rem,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconLock, IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes, describeExpiry } from "@/lib/format";
import { isPreviewableMime } from "@/lib/preview";
import { mimeFromName } from "@/lib/mime";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { downloadDecrypted, type DownloadSecret } from "@/lib/e2e/download-flow";
import {
  canStreamDownload,
  streamToDownload,
  blobDownload,
} from "@/lib/e2e/stream-download";

// Inline preview is fully client-side for v2 shares (the server has no ?inline
// route). Below this size we decrypt the whole file into memory once, so we can
// both render a blob: preview and serve the eventual download without a second
// fetch; larger files skip the prefetch and stream straight to disk. (Spec §5.6)
const PREVIEW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

interface DownloadViewProps {
  slug: string;
  name: string | null; // null when the server can't see it (encrypted)
  size: number;
  mime: string | null; // content type, used to offer an inline image/PDF preview
  expiresAt: number | null;
  hasPassword: boolean;
  linkMode: boolean; // encrypted, key carried in the URL #fragment
  serverMode: boolean; // encrypted, key wrapped with the server master key
  downloadsLeft: number | null; // remaining downloads, or null when unlimited
  // v2 zero-knowledge props (optional; absent for v1)
  format?: number; // 2 = zero-knowledge; absent/undefined = v1 legacy
  wrappedKey?: string | null; // base64-encoded wrapped content key (password mode)
  kdfSalt?: string | null; // base64-encoded KDF salt (password mode)
}

export function DownloadView({
  slug,
  name,
  size,
  mime,
  expiresAt,
  hasPassword,
  linkMode,
  serverMode,
  downloadsLeft,
  format,
  wrappedKey,
  kdfSalt,
}: DownloadViewProps) {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { setColorScheme } = useMantineColorScheme();
  // Resolve "auto" to the displayed scheme so the first toggle isn't a no-op.
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Filename: known from the server for plaintext shares, otherwise revealed
  // after we decrypt the header (link mode on mount, password mode on unlock).
  const [revealedName, setRevealedName] = useState<string | null>(name);
  // Content type used to decide/render the preview. Starts from the DB column and
  // is refined to the authoritative type from the decrypted header once revealed.
  const [revealedMime, setRevealedMime] = useState<string | null>(mime);
  // For small v2 shares we decrypt the whole file once on mount: `decrypted`
  // caches the plaintext blob (reused by the download button — no re-fetch) and
  // `previewUrl` is a blob: URL backing the inline image/PDF preview.
  const [decrypted, setDecrypted] = useState<{
    blob: Blob;
    name: string;
    type: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const downloadUrl = `/api/d/${slug}`;

  const exp = describeExpiry(expiresAt);
  const expiryText =
    exp.kind === "never" || exp.kind === "expired"
      ? t(`relexp.${exp.kind}`)
      : t(`relexp.${exp.kind}`, { count: exp.count });

  // The link key lives only in the URL fragment, never sent to the server in a
  // request line. Read it once on the client.
  const linkKey =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.hash.slice(1)).get("k") ?? ""
      : "";

  // -------------------------------------------------------------------------
  // v2 zero-knowledge download handler
  // The server streams back the raw ciphertext; the browser decrypts in-place.
  // -------------------------------------------------------------------------
  const isV2 = format === 2;

  const v2Download = async () => {
    if (busy) return;
    // Small share already decrypted on mount for the preview — just save the
    // cached blob, no second fetch/decrypt.
    if (decrypted) {
      blobDownload(decrypted.blob, decrypted.name);
      return;
    }
    setBusy(true);
    try {
      // Determine the decryption secret.
      // Link mode: key from the URL fragment (#k=<key>).
      // Password mode: password + wrapped key material from the server props.
      let secret: DownloadSecret;
      if (linkKey) {
        secret = { keyFromUrl: linkKey };
      } else if (hasPassword && wrappedKey && kdfSalt) {
        // Decode base64 → Uint8Array<ArrayBuffer>.
        // Cast required for TS 5.9 strict Uint8Array<ArrayBuffer> variance.
        const wrapped = Uint8Array.from(
          atob(wrappedKey),
          (c) => c.charCodeAt(0),
        ) as unknown as Uint8Array<ArrayBuffer>;
        const salt = Uint8Array.from(
          atob(kdfSalt),
          (c) => c.charCodeAt(0),
        ) as unknown as Uint8Array<ArrayBuffer>;
        secret = { password, wrapped, salt };
      } else {
        // No key in URL and no password material — link was shared without the
        // fragment and has no password; can't decrypt.
        notifications.show({ color: "red", message: t("download.missingKey") });
        return;
      }

      const { meta } = await downloadDecrypted(
        // The flow derives the content key first (a wrong password rejects
        // before any fetch) and hands us its SHA-256 verifier: the server
        // requires this proof of key knowledge before counting the download.
        (keyVerifier) =>
          fetch(downloadUrl, {
            headers: { "x-fd-key-verifier": keyVerifier },
          }).then((r) => {
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            // r.body is ReadableStream<Uint8Array> at runtime.
            return r.body as ReadableStream<Uint8Array>;
          }),
        secret,
        async (plaintext, filename) => {
          if (canStreamDownload()) {
            // No size: `size` is the CIPHERTEXT length (DB column) and the
            // decrypted metadata carries only {name, type} — a Content-Length
            // larger than the plaintext makes Chromium mark the download as
            // failed, so the SW must not set one.
            await streamToDownload(plaintext, filename);
          } else {
            // Blob fallback: collect the stream into memory.
            // Cast to Uint8Array<ArrayBuffer> so TS 5.9 strict variance accepts
            // the chunks as BlobPart[] (SharedArrayBuffer variant is excluded).
            const reader = plaintext.getReader();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value as unknown as Uint8Array<ArrayBuffer>);
            }
            blobDownload(new Blob(chunks), filename);
          }
        },
      );
      // Reveal the real filename after a successful decrypt.
      setRevealedName(meta.name);
      setRevealedMime(meta.type);
    } catch {
      // downloadDecrypted rejects on a wrong key/password.
      notifications.show({
        color: "red",
        message: hasPassword ? t("download.wrongPassword") : t("download.failed"),
      });
    } finally {
      setBusy(false);
    }
  };

  // Auto-decrypt small v2 link shares on mount: reveals the real filename and
  // renders an inline image/PDF preview — all client-side (the server never sees
  // the key or the plaintext). Gated to unlimited, password-less link shares
  // under the size cap; the decrypted blob is cached so the download button
  // reuses it without a second fetch. (Spec §5.6.) Runs in an effect, so reading
  // the #fragment key here can't cause a hydration mismatch.
  useEffect(() => {
    if (!isV2 || hasPassword || downloadsLeft !== null) return;
    if (size > PREVIEW_MAX_BYTES || !linkKey) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        const { meta } = await downloadDecrypted(
          // Same key-verifier header as the download button — the prefetch is a
          // real, counted-eligible GET and must carry the same proof.
          (keyVerifier) =>
            fetch(downloadUrl, {
              headers: { "x-fd-key-verifier": keyVerifier },
            }).then((r) => {
              if (!r.ok) throw new Error(`fetch ${r.status}`);
              return r.body as ReadableStream<Uint8Array>;
            }),
          { keyFromUrl: linkKey },
          async (plaintext) => {
            const reader = plaintext.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value as unknown as Uint8Array<ArrayBuffer>);
            }
          },
        );
        if (cancelled) return;
        const blob = new Blob(chunks, { type: meta.type });
        setDecrypted({ blob, name: meta.name, type: meta.type });
        setRevealedName(meta.name);
        setRevealedMime(meta.type);
        if (isPreviewableMime(meta.type)) {
          objectUrl = URL.createObjectURL(blob);
          setPreviewUrl(objectUrl);
        }
      } catch {
        // Leave the share undecrypted; the download button still works.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isV2, hasPassword, downloadsLeft, size, linkKey, downloadUrl]);

  // -------------------------------------------------------------------------
  // v1 helpers (unchanged)
  // -------------------------------------------------------------------------

  // Authorize the download (POST), then trigger the native streaming GET.
  const authorizeThenDownload = async (cred: {
    password?: string;
    key?: string;
  }) => {
    setBusy(true);
    try {
      const res = await fetch(downloadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cred),
      });
      if (res.status === 401) {
        // 401 means a wrong credential: a bad password, or a corrupt link key.
        const message = cred.password
          ? t("download.wrongPassword")
          : t("download.failed");
        notifications.show({ color: "red", message });
        return false;
      }
      if (!res.ok) throw new Error(`verify ${res.status}`);
      const data = (await res.json()) as { name?: string };
      if (data.name) setRevealedName(data.name);
      // Cookie is set; trigger the native streaming download.
      window.location.href = downloadUrl;
      return true;
    } catch (e) {
      notifications.show({
        color: "red",
        message: e instanceof Error ? e.message : t("download.failed"),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Reveal the real filename on mount for shares that need no password: link
  // mode (decrypt with the #fragment key) and server mode (the server decrypts
  // with its master key, so an empty credential is enough). A POST that decrypts
  // just the header, without downloading yet.
  useEffect(() => {
    // v2 shares reveal the name after decryption — skip this v1-only effect.
    if (isV2) return;
    const cred = linkMode && linkKey ? { key: linkKey } : serverMode ? {} : null;
    if (!cred) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(downloadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cred),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          name?: string;
          mime?: string | null;
        };
        if (cancelled) return;
        if (data.name) setRevealedName(data.name);
        if (data.mime) setRevealedMime(data.mime);
      } catch {
        // Leave the name hidden; the download button still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isV2, linkMode, linkKey, serverMode, downloadUrl]);

  const missingKey = linkMode && !linkKey;

  // Inline preview URL: pass the link key as ?k= so the server can decrypt
  // without relying on the fd_key cookie reaching the image/embed GET (which can
  // fail when a reverse proxy delays or strips Set-Cookie delivery). The key is
  // already in the URL fragment on this page, so no new information is exposed.
  const inlineSrc = `${downloadUrl}?inline=1${linkKey ? `&k=${encodeURIComponent(linkKey)}` : ""}`;

  // Inline preview for images/PDFs — only for unlimited, password-less shares
  // (a preview would otherwise consume or require a counted download). The
  // preview GET (?inline=1) never counts and is refused for limited shares.
  // Prefer the type revealed from the decrypted header over the DB column.
  // Use `||` (not `??`) so both null AND empty-string are treated as missing.
  // Fall back to inferring from the revealed filename: old files stored mime=null
  // (tus encodes empty file.type as null in the sidecar) and the DB column was
  // written before the filename-extension fallback was added to finalize.
  const effectiveMime =
    revealedMime || mime || mimeFromName(revealedName ?? name ?? "");
  const previewable = isPreviewableMime(effectiveMime);
  const canPreview =
    previewable &&
    downloadsLeft === null &&
    !hasPassword &&
    !missingKey &&
    revealedName !== null;

  // v1 previews via the server's ?inline endpoint; v2 has no server inline route
  // and previews from the in-memory blob: URL decrypted on mount above.
  const previewSrc = isV2 ? previewUrl : canPreview ? inlineSrc : null;

  return (
    <Container size="sm" py={60} style={{ position: "relative", minHeight: "100vh" }}>
      {/* Pinned to the viewport top-right — same spot as the upload page,
          independent of this page's narrower Container width. */}
      <Box pos="fixed" top={24} right={24} style={{ zIndex: 2 }}>
        <Group gap="xs">
          <LanguageSwitcher />
          <Tooltip label={t("theme.toggle")} withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("theme.toggle")}
              onClick={() =>
                setColorScheme(computedColorScheme === "dark" ? "light" : "dark")
              }
            >
              {computedColorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>

      {/* Brand at the top, centered, linking home — same as the main page. */}
      <Center mb={88}>
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
          <Group gap="sm" style={{ cursor: "pointer" }}>
            <Logo size={52} />
            <Title
              order={1}
              fw={500}
              style={{
                fontSize: rem(32),
                letterSpacing: -1,
                fontFamily: "var(--font-bitter), Georgia, serif",
                fontStyle: "italic",
              }}
            >
              {appName}
            </Title>
          </Group>
        </Link>
      </Center>

      <Paper radius="lg" p="xl" maw={460} mx="auto" w="100%" className="fd-glass">
        <Stack align="center" gap="lg">
          {/* Logo only (no wordmark) crowning the card, like the drop zone. */}
          <Logo size={48} />

          <Stack align="center" gap={2}>
            <Text fw={700} size="xl" ta="center" lineClamp={2}>
              {revealedName ?? t("download.encryptedFile")}
            </Text>
            <Text c="dimmed" size="sm">
              {formatBytes(size)} · {expiryText}
            </Text>
            {downloadsLeft !== null && (
              <Text c="dimmed" size="xs">
                {t("download.downloadsLeft", { count: downloadsLeft })}
              </Text>
            )}
          </Stack>

          {previewSrc && (
            <Box
              w="100%"
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                minHeight: rem(160),
                borderRadius: "var(--mantine-radius-md)",
                overflow: "hidden",
                background: "var(--mantine-color-default-hover)",
              }}
            >
              {effectiveMime?.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewSrc}
                  alt={revealedName ?? ""}
                  style={{
                    display: "block",
                    maxWidth: "100%",
                    maxHeight: 360,
                    objectFit: "contain",
                  }}
                />
              ) : (
                <embed
                  src={previewSrc}
                  type="application/pdf"
                  style={{
                    display: "block",
                    width: "100%",
                    height: 360,
                    border: "none",
                  }}
                />
              )}
            </Box>
          )}

          {/* -----------------------------------------------------------
              v2 zero-knowledge download UI
              Password mode: password input + Unlock button.
              Link mode:     a single Download button (key is in the fragment).
              The branch depends ONLY on hasPassword (a server-known prop), never
              on the URL #fragment key — the fragment is invisible to the server,
              so branching on it would render different markup on the server vs.
              the client and trip a hydration mismatch (React #418/#423). A link
              that was copied without its #k= fragment is caught at click time by
              v2Download, which shows the missing-key notification.
              ----------------------------------------------------------- */}
          {isV2 ? (
            hasPassword ? (
              <Stack w="100%" gap="sm">
                <PasswordInput
                  label={t("download.protected")}
                  placeholder={t("download.passwordPlaceholder")}
                  leftSection={<IconLock size={16} />}
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void v2Download()}
                />
                <Button
                  fullWidth
                  size="md"
                  leftSection={<IconDownload size={18} />}
                  loading={busy}
                  onClick={() => void v2Download()}
                >
                  {t("download.unlock")}
                </Button>
              </Stack>
            ) : (
              <Button
                fullWidth
                size="md"
                leftSection={<IconDownload size={18} />}
                loading={busy}
                onClick={() => void v2Download()}
              >
                {t("download.download")}
              </Button>
            )
          ) : /* -----------------------------------------------------------
              v1 legacy download UI (unchanged)
              ----------------------------------------------------------- */
          missingKey ? (
            <Text c="red" ta="center" size="sm">
              {t("download.missingKey")}
            </Text>
          ) : hasPassword ? (
            <Stack w="100%" gap="sm">
              <PasswordInput
                label={t("download.protected")}
                placeholder={t("download.passwordPlaceholder")}
                leftSection={<IconLock size={16} />}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && authorizeThenDownload({ password })
                }
              />
              <Button
                fullWidth
                size="md"
                leftSection={<IconDownload size={18} />}
                loading={busy}
                onClick={() => authorizeThenDownload({ password })}
              >
                {t("download.unlock")}
              </Button>
            </Stack>
          ) : (
            <Button
              fullWidth
              size="md"
              leftSection={<IconDownload size={18} />}
              loading={busy}
              onClick={() =>
                authorizeThenDownload(linkMode ? { key: linkKey } : {})
              }
            >
              {t("download.download")}
            </Button>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}
