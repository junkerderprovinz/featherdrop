"use client";

import {
  Button,
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

// Finite expiry pre-selected when the expiry toggle is switched on (matches the
// page's initial state and the server's DEFAULT_EXPIRY).
const EXPIRY_WHEN_ON = "7d";

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

// Right-hand panel that appears once a file is selected: the options the uploader
// can set and the action button, in order — expiry, download limit, password.
// Expiry and the download limit are each behind a toggle; switching expiry off
// shares the file with no expiry ("never").
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
  const expires = expiry !== "never";
  return (
    <Paper
      radius="lg"
      p="lg"
      w={{ base: "100%", sm: 300 }}
      style={{ background: "transparent" }}
    >
      <Stack gap="md">
        <Text fw={600}>{t("settings.title")}</Text>

        {/* 1. Expiry — toggle a finite lifetime on/off (off = never expires). */}
        <Switch
          label={t("settings.expiresAfter")}
          checked={expires}
          onChange={(e) =>
            onExpiryChange(e.currentTarget.checked ? EXPIRY_WHEN_ON : "never")
          }
          disabled={uploading}
        />
        {expires && (
          <Select
            value={expiry}
            onChange={(v) => v && onExpiryChange(v)}
            data={EXPIRY_OPTIONS.filter((o) => o.value !== "never").map((o) => ({
              value: o.value,
              label: t(`expiry.${o.value}`),
            }))}
            allowDeselect={false}
            disabled={uploading}
            comboboxProps={{ withinPortal: true }}
          />
        )}

        {/* 2. Download limit / burn-after-download. The switch toggles between
            unlimited (null) and a capped count (defaulting to 1). */}
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

        {/* 3. Optional password. */}
        <PasswordInput
          label={t("settings.password")}
          placeholder={t("settings.passwordPlaceholder")}
          leftSection={<IconLock size={16} />}
          value={password}
          onChange={(e) => onPasswordChange(e.currentTarget.value)}
          disabled={uploading}
        />

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
