// A link to copy: read-only, selected on focus, with a copy button.
import { useState } from "react";
import { ActionIcon, TextInput, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";

export function LinkField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <TextInput
      label={label}
      value={value}
      readOnly
      onFocus={(e) => e.currentTarget.select()}
      rightSection={
        <Tooltip label={copied ? t("result.copied") : t("result.copy")} withArrow>
          <ActionIcon variant="subtle" aria-label={t("result.copy")} onClick={() => void copy()}>
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          </ActionIcon>
        </Tooltip>
      }
    />
  );
}
