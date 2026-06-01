"use client";

import {
  Button,
  Divider,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Switch,
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
  maxDownloads: number | null;
  onMaxDownloadsChange: (value: number | null) => void;
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
  maxDownloads,
  onMaxDownloadsChange,
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

        {/* Optional download limit / burn-after-download. The switch toggles
            between unlimited (null) and a capped count (defaulting to 1). */}
        <Switch
          label={t("settings.limitDownloads")}
          checked={maxDownloads !== null}
          onChange={(e) =>
            onMaxDownloadsChange(e.currentTarget.checked ? 1 : null)
          }
          disabled={uploading}
        />
        {maxDownloads !== null && (
          <NumberInput
            label={t("settings.maxDownloads")}
            min={1}
            max={10000}
            clampBehavior="strict"
            value={maxDownloads ?? 1}
            onChange={(v) =>
              onMaxDownloadsChange(typeof v === "number" && v >= 1 ? v : 1)
            }
            disabled={uploading}
          />
        )}

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
