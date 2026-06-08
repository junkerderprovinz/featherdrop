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
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";

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
  }, [linkMode, linkKey, serverMode, downloadUrl]);

  const missingKey = linkMode && !linkKey;

  // Inline preview URL: pass the link key as ?k= so the server can decrypt
  // without relying on the fd_key cookie reaching the image/embed GET (which can
  // fail when a reverse proxy delays or strips Set-Cookie delivery). The key is
  // already in the URL fragment on this page, so no new information is exposed.
  const inlineSrc = `${downloadUrl}?inline=1${linkKey ? `&k=${encodeURIComponent(linkKey)}` : ""}`;

  // Inline preview for images/PDFs — only for unlimited, password-less shares
  // (a preview would otherwise consume or require a counted download). The
  // preview GET (?inline=1) never counts and is refused for limited shares.
  // Prefer the type revealed from the decrypted header over the DB column, which
  // can be empty when the uploader's browser supplied no content type.
  const effectiveMime = revealedMime ?? mime;
  const previewable = isPreviewableMime(effectiveMime);
  const canPreview =
    previewable &&
    downloadsLeft === null &&
    !hasPassword &&
    !missingKey &&
    revealedName !== null;

  return (
    <Container size="sm" py={60} style={{ position: "relative", minHeight: "100vh" }}>
      <Box pos="absolute" top={24} right={24} style={{ zIndex: 2 }}>
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

          {canPreview && (
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
                  src={inlineSrc}
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
                  src={inlineSrc}
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

          {missingKey ? (
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
