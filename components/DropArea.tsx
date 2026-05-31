"use client";

import { Box, Center, Group, RingProgress, Stack, Text, rem } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import {
  IconCloudUpload,
  IconFile,
  IconX,
} from "@tabler/icons-react";
import { formatBytes } from "@/lib/format";

interface DropAreaProps {
  onDrop: (file: File) => void;
  uploading: boolean;
  progress: number; // 0–100
  fileName?: string;
  fileSize?: number;
}

// The central, always-visible drop target. While an upload runs, a translucent
// overlay with a ring shows progress directly on the zone.
export function DropArea({
  onDrop,
  uploading,
  progress,
  fileName,
  fileSize,
}: DropAreaProps) {
  return (
    <Box pos="relative" style={{ flex: 1, minWidth: rem(280) }}>
      <Dropzone
        onDrop={(files) => files[0] && onDrop(files[0])}
        disabled={uploading}
        multiple={false}
        radius="lg"
        h={rem(280)}
        style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <Stack align="center" gap="xs" style={{ pointerEvents: "none" }}>
          <Dropzone.Accept>
            <IconCloudUpload size={56} stroke={1.4} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={56} stroke={1.4} />
          </Dropzone.Reject>
          <Dropzone.Idle>
            {fileName ? (
              <IconFile size={56} stroke={1.2} />
            ) : (
              <IconCloudUpload size={56} stroke={1.2} />
            )}
          </Dropzone.Idle>

          {fileName ? (
            <Stack align="center" gap={2}>
              <Text fw={600} size="lg" lineClamp={1}>
                {fileName}
              </Text>
              {fileSize !== undefined && (
                <Text c="dimmed" size="sm">
                  {formatBytes(fileSize)} · drop another to replace
                </Text>
              )}
            </Stack>
          ) : (
            <Stack align="center" gap={2}>
              <Text fw={600} size="lg">
                Drag a file here
              </Text>
              <Text c="dimmed" size="sm">
                or click to browse
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
            backdropFilter: "blur(2px)",
            background: "rgba(0,0,0,0.35)",
          }}
        >
          <Group>
            <RingProgress
              size={120}
              thickness={10}
              roundCaps
              sections={[{ value: progress, color: "violet" }]}
              label={
                <Text c="white" fw={700} ta="center" size="lg">
                  {Math.round(progress)}%
                </Text>
              }
            />
          </Group>
        </Center>
      )}
    </Box>
  );
}
