"use client";

import { useState } from "react";
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
  name: string;
  size: number;
  expiresAt: number | null;
  hasPassword: boolean;
}

export function DownloadView({
  slug,
  name,
  size,
  expiresAt,
  hasPassword,
}: DownloadViewProps) {
  const { t } = useTranslation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const downloadUrl = `/api/d/${slug}`;

  const exp = describeExpiry(expiresAt);
  const expiryText =
    exp.kind === "never" || exp.kind === "expired"
      ? t(`relexp.${exp.kind}`)
      : t(`relexp.${exp.kind}`, { count: exp.count });

  const unlockAndDownload = async () => {
    setBusy(true);
    try {
      const res = await fetch(downloadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 401) {
        notifications.show({ color: "red", message: t("download.wrongPassword") });
        return;
      }
      if (!res.ok) throw new Error(`verify ${res.status}`);
      // Cookie is set; trigger the native streaming download.
      window.location.href = downloadUrl;
    } catch (e) {
      notifications.show({
        color: "red",
        message: e instanceof Error ? e.message : t("download.failed"),
      });
    } finally {
      setBusy(false);
    }
  };

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
      <Paper withBorder radius="xl" p="xl" maw={460} w="100%">
        <Stack align="center" gap="lg">
          <Group gap={6}>
            <Logo size={22} />
            <Text fw={800} size="lg">
              featherdrop
            </Text>
          </Group>

          <Stack align="center" gap={2}>
            <Text fw={700} size="xl" ta="center" lineClamp={2}>
              {name}
            </Text>
            <Text c="dimmed" size="sm">
              {formatBytes(size)} · {expiryText}
            </Text>
          </Stack>

          {hasPassword ? (
            <Stack w="100%" gap="sm">
              <PasswordInput
                label={t("download.protected")}
                placeholder={t("download.passwordPlaceholder")}
                leftSection={<IconLock size={16} />}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && unlockAndDownload()}
              />
              <Button
                fullWidth
                size="md"
                leftSection={<IconDownload size={18} />}
                loading={busy}
                onClick={unlockAndDownload}
              >
                {t("download.unlock")}
              </Button>
            </Stack>
          ) : (
            <Button
              fullWidth
              size="md"
              component="a"
              href={downloadUrl}
              leftSection={<IconDownload size={18} />}
            >
              {t("download.download")}
            </Button>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
