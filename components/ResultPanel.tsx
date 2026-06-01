"use client";

import { useEffect, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconPlus } from "@tabler/icons-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";

interface ResultPanelProps {
  url: string;
  expiryLabel: string;
  onReset: () => void;
}

// Shown after a successful upload: the shareable link, a copy button, a QR code
// for phones, and a way to start over.
export function ResultPanel({ url, expiryLabel, onReset }: ResultPanelProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // This panel mounts only once the share link exists — i.e. the upload reached
  // 100% — so a short gold/violet confetti burst here celebrates completion.
  // Loaded lazily so it never weighs on the initial bundle; honours reduced motion.
  useEffect(() => {
    let cancelled = false;
    void import("canvas-confetti").then(({ default: confetti }) => {
      if (cancelled) return;
      const colors = ["#F6D981", "#D4AF37", "#A97C0A", "#7C3AED"];
      confetti({
        particleCount: 90,
        spread: 72,
        startVelocity: 42,
        origin: { y: 0.32 },
        colors,
        disableForReducedMotion: true,
      });
      confetti({
        particleCount: 55,
        spread: 110,
        startVelocity: 30,
        scalar: 0.9,
        origin: { y: 0.28 },
        colors,
        disableForReducedMotion: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Robust copy: works on plain-HTTP LAN access too (see lib/clipboard.ts),
  // where navigator.clipboard is unavailable and the modern path silently fails.
  const onCopy = async () => {
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      notifications.show({ color: "red", message: t("result.copyFailed") });
    }
  };

  return (
    <Paper radius="lg" p="xl" maw={520} mx="auto" w="100%" className="fd-glass">
      <Stack align="center" gap="lg">
        <Stack align="center" gap={4}>
          <Text fw={700} size="xl">
            {t("result.ready")}
          </Text>
          <Text c="dimmed" size="sm" ta="center">
            {t("app.subtitle")}
          </Text>
          <Text c="dimmed" size="sm" fw={600}>
            {expiryLabel}
          </Text>
        </Stack>

        <Box
          p="md"
          bg="white"
          style={{ borderRadius: "var(--mantine-radius-md)" }}
        >
          <QRCodeSVG value={url} size={160} />
        </Box>

        <Group w="100%" gap="xs" wrap="nowrap">
          <TextInput
            value={url}
            readOnly
            style={{ flex: 1 }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Tooltip label={copied ? t("result.copied") : t("result.copy")} withArrow>
            <ActionIcon
              size={36}
              variant={copied ? "filled" : "light"}
              color={copied ? "teal" : "fdgold"}
              onClick={onCopy}
              aria-label={t("result.copy")}
            >
              {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>

        <Button
          variant="subtle"
          leftSection={<IconPlus size={16} />}
          onClick={onReset}
        >
          {t("result.shareAnother")}
        </Button>
      </Stack>
    </Paper>
  );
}
