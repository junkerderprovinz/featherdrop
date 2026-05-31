"use client";

import {
  ActionIcon,
  Box,
  Button,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy, IconPlus } from "@tabler/icons-react";
import { QRCodeSVG } from "qrcode.react";

interface ResultPanelProps {
  url: string;
  expiryLabel: string;
  onReset: () => void;
}

// Shown after a successful upload: the shareable link, a copy button, a QR code
// for phones, and a way to start over.
export function ResultPanel({ url, expiryLabel, onReset }: ResultPanelProps) {
  return (
    <Paper withBorder radius="lg" p="xl" maw={520} mx="auto" w="100%">
      <Stack align="center" gap="lg">
        <Stack align="center" gap={4}>
          <Text fw={700} size="xl">
            Ready to share
          </Text>
          <Text c="dimmed" size="sm">
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
          <TextInput value={url} readOnly style={{ flex: 1 }} />
          <CopyButton value={url} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copied" : "Copy link"} withArrow>
                <ActionIcon
                  size={36}
                  variant={copied ? "filled" : "light"}
                  color={copied ? "teal" : "violet"}
                  onClick={copy}
                >
                  {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>

        <Button
          variant="subtle"
          leftSection={<IconPlus size={16} />}
          onClick={onReset}
        >
          Share another file
        </Button>
      </Stack>
    </Paper>
  );
}
