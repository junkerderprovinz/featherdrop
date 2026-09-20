"use client";

import { Box, Center, Group, RingProgress, ScrollArea, Stack, Text, rem } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconCloudUpload, IconFile, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/format";
import { filesFromDropEvent } from "@/lib/dropped-files";
import { Logo } from "@/components/Logo";

interface DropAreaProps {
  onDrop: (files: File[]) => void;
  uploading: boolean;
  progress: number; // 0 to 100
  files: File[];
  /** Shown beneath the progress ring, such as "Encrypting…". */
  phaseLabel?: string;
}

// While an upload runs, an overlay with a progress ring covers the zone.
export function DropArea({
  onDrop,
  uploading,
  progress,
  files,
  phaseLabel,
}: DropAreaProps) {
  const { t } = useTranslation();
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return (
    <Box pos="relative" style={{ flex: 1, minWidth: rem(280) }}>
      <Dropzone
        onDrop={(dropped) => dropped.length > 0 && onDrop(dropped)}
        // react-dropzone's webkitGetAsEntry() walk crashes Chromium and Edge
        // renderers on some setups (#4).
        getFilesFromEvent={(event) => Promise.resolve(filesFromDropEvent(event))}
        disabled={uploading}
        multiple
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
          <Logo size={48} />

          <Dropzone.Accept>
            <IconCloudUpload size={40} stroke={1.4} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={40} stroke={1.4} />
          </Dropzone.Reject>

          {files.length === 1 ? (
            <Stack align="center" gap={2}>
              <Group gap={8} wrap="nowrap">
                <IconFile size={20} stroke={1.4} />
                <Text fw={600} size="lg" lineClamp={1}>
                  {files[0].name}
                </Text>
              </Group>
              <Text c="dimmed" size="sm">
                {formatBytes(files[0].size)} · {t("drop.replace")}
              </Text>
            </Stack>
          ) : files.length > 1 ? (
            <Stack align="center" gap={6} w="100%" maw={rem(260)}>
              <ScrollArea.Autosize mah={rem(132)} type="auto" w="100%">
                <Stack gap={2} px="xs">
                  {files.map((f, i) => (
                    <Group key={`${f.name}-${i}`} gap={6} wrap="nowrap" justify="center">
                      <IconFile size={16} stroke={1.4} />
                      <Text size="sm" lineClamp={1} style={{ flex: 1 }}>
                        {f.name}
                      </Text>
                      <Text c="dimmed" size="xs" style={{ whiteSpace: "nowrap" }}>
                        {formatBytes(f.size)}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              <Text c="dimmed" size="sm" ta="center">
                {t("drop.fileCount", { count: files.length })} ·{" "}
                {t("drop.total", { size: formatBytes(totalSize) })} · {t("drop.replaceMulti")}
              </Text>
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
          <Stack align="center" gap={8}>
            <RingProgress
              size={130}
              thickness={9}
              roundCaps
              sections={[{ value: progress, color: "fdgold" }]}
              label={
                <Text c="white" fw={700} ta="center" size="lg">
                  {Math.round(progress)}%
                </Text>
              }
            />
            {phaseLabel && (
              <Text c="white" size="sm" ta="center">
                {phaseLabel}
              </Text>
            )}
          </Stack>
        </Center>
      )}
    </Box>
  );
}
