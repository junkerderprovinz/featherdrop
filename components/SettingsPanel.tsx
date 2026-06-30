"use client";

import { useState } from "react";
import {
  Button,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { IconSend } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EXPIRY_OPTIONS } from "@/lib/expiry";

// Finite expiry pre-selected when the expiry toggle is switched on (matches the
// page's initial state and the server's DEFAULT_EXPIRY).
const EXPIRY_WHEN_ON = "7d";

// One width for every right-hand control so the option rows line up exactly.
const CONTROL_W = 156;

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

// The options shown once a file is selected. Each option is ONE tidy row: a
// toggle on the left and its control on the right, ALWAYS visible — just disabled
// (greyed) when the toggle is off. Expiry off = never expires; limit off =
// unlimited; password off = no password. Consistent + orderly across all three.
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
  const limited = maxDownloads !== null;

  // Password is its own toggle. It can't be derived purely from the value
  // (empty = off) because the toggle must stay ON while the user is still
  // typing an empty field; so we track it locally. Initialised from the prop so
  // a remount with a password already set shows the toggle on.
  const [pwEnabled, setPwEnabled] = useState(password !== "");

  return (
    <Stack gap="lg" w="100%">
      <Text fw={600}>{t("settings.title")}</Text>

      {/* Expiry — toggle on the left, the duration on the right (greyed = never
          expires when off). */}
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Switch
          label={t("settings.expiresAfter")}
          checked={expires}
          onChange={(e) =>
            onExpiryChange(e.currentTarget.checked ? EXPIRY_WHEN_ON : "never")
          }
          disabled={uploading}
        />
        <Select
          w={CONTROL_W}
          value={expires ? expiry : EXPIRY_WHEN_ON}
          onChange={(v) => v && onExpiryChange(v)}
          data={EXPIRY_OPTIONS.filter((o) => o.value !== "never").map((o) => ({
            value: o.value,
            label: t(`expiry.${o.value}`),
          }))}
          allowDeselect={false}
          disabled={!expires || uploading}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>

      {/* Download limit — toggle + count (greyed = unlimited when off). */}
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Switch
          label={t("settings.limitDownloads")}
          checked={limited}
          onChange={(e) =>
            onMaxDownloadsChange(e.currentTarget.checked ? 1 : null)
          }
          disabled={uploading}
        />
        <NumberInput
          w={CONTROL_W}
          min={1}
          max={10000}
          clampBehavior="strict"
          value={maxDownloads ?? 1}
          onChange={(v) =>
            onMaxDownloadsChange(typeof v === "number" && v >= 1 ? v : 1)
          }
          disabled={!limited || uploading}
        />
      </Group>

      {/* Password — toggle + field (greyed = no password when off). */}
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Switch
          // The dedicated toggle already conveys "optional", so strip any trailing
          // "(optional)" parenthetical from the label across every locale.
          label={t("settings.password").replace(/\s*\([^)]*\)\s*$/, "")}
          checked={pwEnabled}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setPwEnabled(on);
            if (!on) onPasswordChange(""); // clear the secret when switched off
          }}
          disabled={uploading}
        />
        <PasswordInput
          w={CONTROL_W}
          value={password}
          onChange={(e) => onPasswordChange(e.currentTarget.value)}
          disabled={!pwEnabled || uploading}
        />
      </Group>

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
  );
}
