"use client";

import { Box, Center, Group, RingProgress, Stack, Text, rem } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconCloudUpload, IconFile, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/format";
import { Logo } from "@/components/Logo";

interface DropAreaProps {
  onDrop: (file: File) => void;
  uploading: boolean;
  progress: number; // 0–100
  fileName?: string;
  fileSize?: number;
}

// The central, always-visible drop target — a frosted-glass panel with the
// feather mark crowning the top. While an upload runs, a translucent overlay
// with a progress ring shows directly on the zone.
export function DropArea({
  onDrop,
  uploading,
  progress,
  fileName,
  fileSize,
}: DropAreaProps) {
  const { t } = useTranslation();
  return (
    <Box pos="relative" style={{ flex: 1, minWidth: rem(280) }}>
      <Dropzone
        onDrop={(files) => files[0] && onDrop(files[0])}
        disabled={uploading}
        multiple={false}
        radius="lg"
        h={rem(300)}
        className="fd-glass-inner"
        styles={{ root: { background: "transparent", border: "none" } }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Stack align="center" gap="md" style={{ pointerEvents: "none" }}>
          {/* Logo (no wordmark) crowning the drop zone. */}
          <Logo size={48} />

          <Dropzone.Accept>
            <IconCloudUpload size={40} stroke={1.4} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={40} stroke={1.4} />
          </Dropzone.Reject>

          {fileName ? (
            <Stack align="center" gap={2}>
              <Group gap={8} wrap="nowrap">
                <IconFile size={20} stroke={1.4} />
                <Text fw={600} size="lg" lineClamp={1}>
                  {fileName}
                </Text>
              </Group>
              {fileSize !== undefined && (
                <Text c="dimmed" size="sm">
                  {formatBytes(fileSize)} · {t("drop.replace")}
                </Text>
              )}
            </Stack>
          ) : (
            <Stack align="center" gap={2}>
              <Text fw={600} size="lg">
                {t("drop.drag")}
              </Text>
              <Text c="dimmed" size="sm">
                {t("drop.browse")}
              </Text>
            </Stack>
          )}
        </Stack>
      </Dropzone>

      {uploading && (
        <Center
          pos="absolute"
          inset={0}
          style={{
            borderRadius: "var(--mantine-radius-lg)",
            backdropFilter: "blur(3px)",
            background: "rgba(10, 8, 4, 0.45)",
          }}
        >
          <RingProgress
            size={130}
            thickness={9}
            roundCaps
            sections={[{ value: progress, color: "yellow" }]}
            label={
              <Text c="white" fw={700} ta="center" size="lg">
                {Math.round(progress)}%
              </Text>
            }
          />
        </Center>
      )}
    </Box>
  );
}
