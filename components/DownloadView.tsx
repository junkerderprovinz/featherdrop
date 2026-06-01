"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconLock, IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes, describeExpiry } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";

interface DownloadViewProps {
  slug: string;
  name: string | null; // null when the server can't see it (encrypted)
  size: number;
  expiresAt: number | null;
  hasPassword: boolean;
  linkMode: boolean; // encrypted, key carried in the URL #fragment
  serverMode: boolean; // encrypted, key wrapped with the server master key
}

export function DownloadView({
  slug,
  name,
  size,
  expiresAt,
  hasPassword,
  linkMode,
  serverMode,
}: DownloadViewProps) {
  const { t } = useTranslation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Filename: known from the server for plaintext shares, otherwise revealed
  // after we decrypt the header (link mode on mount, password mode on unlock).
  const [revealedName, setRevealedName] = useState<string | null>(name);
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
        const data = (await res.json()) as { name?: string };
        if (!cancelled && data.name) setRevealedName(data.name);
      } catch {
        // Leave the name hidden; the download button still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [linkMode, linkKey, serverMode, downloadUrl]);

  const missingKey = linkMode && !linkKey;

  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Box pos="absolute" top={16} right={16}>
        <Group gap="xs">
          <LanguageSwitcher />
          <Tooltip label={t("theme.toggle")} withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("theme.toggle")}
              onClick={() =>
                setColorScheme(colorScheme === "dark" ? "light" : "dark")
              }
            >
              {colorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
      <Paper radius="lg" p="xl" maw={460} w="100%" className="fd-glass">
        <Stack align="center" gap="lg">
          <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <Group gap={6} style={{ cursor: "pointer" }}>
              <Logo size={22} />
              <Text fw={800} size="lg">
                featherdrop
              </Text>
            </Group>
          </Link>

          <Stack align="center" gap={2}>
            <Text fw={700} size="xl" ta="center" lineClamp={2}>
              {revealedName ?? t("download.encryptedFile")}
            </Text>
            <Text c="dimmed" size="sm">
              {formatBytes(size)} · {expiryText}
            </Text>
          </Stack>

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
    </Center>
  );
}
