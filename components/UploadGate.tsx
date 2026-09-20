"use client";

import { useState } from "react";
import {
  Button,
  PasswordInput,
  Stack,
  Text,
} from "@mantine/core";
import { IconKey, IconLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

// Asks for the upload password when UPLOAD_PASSWORD is set. The server never
// sends the secret; the one typed here goes along in `x-fd-upload-token`.
interface UploadGateProps {
  onUnlock: (token: string) => void;
  /** A localized error such as "Wrong upload password"; empty for none. */
  error?: string;
}

export function UploadGate({ onUnlock, error }: UploadGateProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  const submit = () => {
    const token = value.trim();
    if (token.length === 0) return;
    onUnlock(token);
  };

  return (
    <Stack gap="md" align="center" maw={420} w="100%">
      <IconLock size={32} stroke={1.5} />
      <Text fw={600} ta="center">
        {t("uploadGate.title")}
      </Text>
      <PasswordInput
        w="100%"
        label={t("uploadGate.password")}
        placeholder={t("uploadGate.placeholder")}
        leftSection={<IconKey size={16} />}
        value={value}
        error={error || undefined}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        data-autofocus
      />
      <Button fullWidth size="md" onClick={submit} disabled={value.trim().length === 0}>
        {t("uploadGate.unlock")}
      </Button>
    </Stack>
  );
}
