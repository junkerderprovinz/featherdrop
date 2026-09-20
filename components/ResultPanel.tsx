"use client";

import { useEffect, useRef, useState } from "react";
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
import { IconCheck, IconCopy, IconDownload, IconPlus } from "@tabler/icons-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";

interface ResultPanelProps {
  url: string;
  expiryLabel: string;
  onReset: () => void;
}

// The on-screen QR edge in px; the saved PNG is four times as large.
const QR_SIZE = 160;

// Shown after a successful upload: the link, a copy button, a QR code for
// phones and a way to start over.
export function ResultPanel({ url, expiryLabel, onReset }: ResultPanelProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);

  // The panel mounts when the upload has finished, which a short confetti burst
  // celebrates. It loads lazily to stay out of the initial bundle.
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

  // Rasterizes the rendered SVG onto a white canvas so the QR can be printed or
  // pasted into a chat.
  const onDownloadQr = () => {
    const svg = qrRef.current?.querySelector("svg");
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const svgUrl = URL.createObjectURL(
      new Blob([xml], { type: "image/svg+xml" }),
    );
    const img = new Image();
    img.onload = () => {
      const size = QR_SIZE * 4;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(svgUrl);
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "featherdrop-qr.png";
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = svgUrl;
  };

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
      <Stack align="center" gap="xl">
        <Stack align="center" gap={4}>
          <Text fw={700} size="xl" ta="center">
            {t("result.ready")}
          </Text>
          <Text c="dimmed" size="sm" ta="center">
            {expiryLabel}
          </Text>
        </Stack>

        <Stack align="center" gap="md" w="100%">
          <Stack align="center" gap="xs">
            <Box
              ref={qrRef}
              p="md"
              bg="white"
              style={{ borderRadius: "var(--mantine-radius-md)" }}
            >
              <QRCodeSVG value={url} size={QR_SIZE} />
            </Box>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconDownload size={14} />}
              onClick={onDownloadQr}
            >
              {t("result.downloadQr")}
            </Button>
          </Stack>

          <Group w="100%" gap="xs" wrap="nowrap">
            <TextInput
              value={url}
              readOnly
              style={{ flex: 1 }}
              aria-label={t("result.copy")}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Tooltip label={copied ? t("result.copied") : t("result.copy")} withArrow>
              <ActionIcon
                size={36}
                variant={copied ? "filled" : "light"}
                color={copied ? "teal" : "fdgold"}
                onClick={onCopy}
                aria-label={t("result.copy")}
                className="fd-icon-btn"
                data-copied={copied || undefined}
              >
                {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Stack>

        <Button
          fullWidth
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
