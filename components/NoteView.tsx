// A decrypted note. It goes into the page as a text node inside a <pre>, so
// markup in a note is shown, never parsed.

import { useState } from "react";
import { Button, Paper, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";

export function NoteView({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Stack w="100%" gap="sm">
      <Paper withBorder radius="md" p="md" style={{ maxHeight: 480, overflow: "auto" }}>
        <Text
          component="pre"
          size="sm"
          m={0}
          ff="monospace"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {text}
        </Text>
      </Paper>
      <Button
        variant="light"
        leftSection={copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
        onClick={() => void copy()}
      >
        {copied ? t("result.copied") : t("note.copy")}
      </Button>
    </Stack>
  );
}
