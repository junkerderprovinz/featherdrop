"use client";

import { useState } from "react";
import {
  Button,
  Center,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconLock } from "@tabler/icons-react";
import { formatBytes, formatExpiry } from "@/lib/format";
import { Logo } from "@/components/Logo";

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
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const downloadUrl = `/api/d/${slug}`;

  const unlockAndDownload = async () => {
    setBusy(true);
    try {
      const res = await fetch(downloadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 401) {
        notifications.show({ color: "red", message: "Wrong password" });
        return;
      }
      if (!res.ok) throw new Error(`verify ${res.status}`);
      // Cookie is set; trigger the native streaming download.
      window.location.href = downloadUrl;
    } catch (e) {
      notifications.show({
        color: "red",
        message: e instanceof Error ? e.message : "Download failed",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center style={{ minHeight: "100vh" }} p="md">
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
              {formatBytes(size)} · {formatExpiry(expiresAt)}
            </Text>
          </Stack>

          {hasPassword ? (
            <Stack w="100%" gap="sm">
              <PasswordInput
                label="This file is password protected"
                placeholder="Enter password"
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
                Unlock &amp; download
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
              Download
            </Button>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
