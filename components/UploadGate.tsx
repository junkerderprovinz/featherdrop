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

// Upload gate shown only when the instance sets UPLOAD_PASSWORD (server exposes
// the boolean `uploadProtected`). The operator's secret is NEVER sent to the
// client — the user types it here and it is attached to the upload requests via
// the `x-fd-upload-token` header; the server verifies it constant-time. A wrong
// secret surfaces as an error (passed in via `error`) and the user can retry.
interface UploadGateProps {
  /** Called with the entered secret when the user unlocks. */
  onUnlock: (token: string) => void;
  /** Localized error to show (e.g. "Wrong upload password"); empty = none. */
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
