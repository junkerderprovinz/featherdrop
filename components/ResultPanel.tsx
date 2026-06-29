"use client";

import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";

interface ResultPanelProps {
  url: string;
  /**
   * Secret "delete early" link for the uploader (…/m/<slug>#t=<token>). The token
   * lives in the URL fragment, so it never reaches the server on navigation —
   * exactly like the content key. Shown as a separate, clearly-labelled secret.
   * Absent for legacy servers that don't mint a manage token.
   */
  manageUrl?: string;
  expiryLabel: string;
  onReset: () => void;
}

// On-screen QR edge in px; the PNG download rasterizes at 4× this. One source so
// the displayed code and the saved file can never drift apart.
const QR_SIZE = 160;

// Shown after a successful upload: the shareable link, a copy button, a QR code
// for phones, and a way to start over.
export function ResultPanel({
  url,
  manageUrl,
  expiryLabel,
  onReset,
}: ResultPanelProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [manageCopied, setManageCopied] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);

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

  // Save the QR as a crisp PNG so it can be printed or pasted into a chat: take
  // the rendered SVG, rasterize it onto a white canvas at 4× and trigger a
  // download. Pure client work — no extra dependency, no server round-trip.
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

  // Copy the secret management ("delete early") link. Same robust copy path as
  // the share link, with its own feedback so the two buttons don't share state.
  const onCopyManage = async () => {
    if (!manageUrl) return;
    const ok = await copyText(manageUrl);
    if (ok) {
      setManageCopied(true);
      setTimeout(() => setManageCopied(false), 2000);
    } else {
      notifications.show({ color: "red", message: t("result.copyFailed") });
    }
  };

  return (
    <Paper radius="lg" p="xl" maw={520} mx="auto" w="100%" className="fd-glass">
      <Stack align="center" gap="xl">
        {/* Header — the success state and the share's expiry, centred. */}
        <Stack align="center" gap={4}>
          <Text fw={700} size="xl" ta="center">
            {t("result.ready")}
          </Text>
          <Text c="dimmed" size="sm" ta="center">
            {expiryLabel}
          </Text>
        </Stack>

        {/* Primary block: the QR + the share link with its copy button. This is
            the one thing the user came for, so it leads and stays visually
            dominant (gold copy accent, full-size input). */}
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
              >
                {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Stack>

        {/* Secondary, clearly-separated secret: the management link the uploader
            keeps private to delete the share before it expires. The delete token
            rides in the URL #fragment (never sent to the server on navigation),
            exactly like the content key. Shown only when the server returned one.
            Same alignment + copy-button colours as the primary block so the two
            read as one consistent family, just at a quieter (xs) scale. */}
        {manageUrl && (
          <>
            <Divider w="100%" />
            <Stack w="100%" gap="xs">
              <Group gap={6} wrap="nowrap">
                <IconTrash size={16} style={{ opacity: 0.7 }} />
                <Text fw={600} size="sm">
                  {t("result.manageTitle")}
                </Text>
              </Group>
              <Text c="dimmed" size="xs">
                {t("result.manageHint")}
              </Text>
              <Group w="100%" gap="xs" wrap="nowrap">
                <TextInput
                  value={manageUrl}
                  readOnly
                  size="xs"
                  style={{ flex: 1 }}
                  aria-label={t("result.manageTitle")}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Tooltip
                  label={manageCopied ? t("result.copied") : t("result.copy")}
                  withArrow
                >
                  <ActionIcon
                    size={36}
                    variant={manageCopied ? "filled" : "light"}
                    color={manageCopied ? "teal" : "fdgold"}
                    onClick={onCopyManage}
                    aria-label={t("result.copyManage")}
                  >
                    {manageCopied ? (
                      <IconCheck size={18} />
                    ) : (
                      <IconCopy size={18} />
                    )}
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Stack>
          </>
        )}

        {/* Tertiary action — start over. A subtle, full-width button so it reads
            clearly as the way out without competing with the share link. */}
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
