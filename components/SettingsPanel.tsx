"use client";

import {
  Button,
  Divider,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { IconLock, IconSend } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EXPIRY_OPTIONS } from "@/lib/expiry";

interface SettingsPanelProps {
  expiry: string;
  onExpiryChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onUpload: () => void;
  uploading: boolean;
}

// Right-hand panel that appears once a file is selected: the few options the
// uploader can set (expiry + optional password) and the action button.
export function SettingsPanel({
  expiry,
  onExpiryChange,
  password,
  onPasswordChange,
  onUpload,
  uploading,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  return (
    <Paper
      radius="lg"
      p="lg"
      w={{ base: "100%", sm: 300 }}
      style={{ background: "transparent" }}
    >
      <Stack gap="md">
        <Text fw={600}>{t("settings.title")}</Text>

        <Select
          label={t("settings.expiresAfter")}
          value={expiry}
          onChange={(v) => v && onExpiryChange(v)}
          data={EXPIRY_OPTIONS.map((o) => ({
            value: o.value,
            label: t(`expiry.${o.value}`),
          }))}
          allowDeselect={false}
          disabled={uploading}
          comboboxProps={{ withinPortal: true }}
        />

        <PasswordInput
          label={t("settings.password")}
          placeholder={t("settings.passwordPlaceholder")}
          leftSection={<IconLock size={16} />}
          value={password}
          onChange={(e) => onPasswordChange(e.currentTarget.value)}
          disabled={uploading}
        />

        <Divider />

        <Button
          fullWidth
          size="md"
          leftSection={<IconSend size={18} />}
          onClick={onUpload}
          loading={uploading}
        >
          {t("settings.upload")}
        </Button>
      </Stack>
    </Paper>
  );
}
