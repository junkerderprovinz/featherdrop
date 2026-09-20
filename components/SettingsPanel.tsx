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
import { allowedExpiryOptions, clampExpiry } from "@/lib/expiry";

// One width for every control so the option rows line up.
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
  // MAX_EXPIRY, "" for none. With a cap, longer options are hidden and the
  // expiry cannot be switched off.
  maxExpiry: string;
  // Selected when the expiry is switched on.
  defaultExpiry: string;
  // The metadata row only shows when a JPEG is selected.
  showMetadataStrip: boolean;
  stripMetadata: boolean;
  onStripMetadataChange: (value: boolean) => void;
}

// Each option is a row with a toggle and its control, which stays visible and
// is disabled while the toggle is off. Expiry off means never, limit off
// unlimited, password off none.
export function SettingsPanel({
  expiry,
  onExpiryChange,
  password,
  onPasswordChange,
  maxDownloads,
  onMaxDownloadsChange,
  onUpload,
  uploading,
  maxExpiry,
  defaultExpiry,
  showMetadataStrip,
  stripMetadata,
  onStripMetadataChange,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const expires = expiry !== "never";
  const limited = maxDownloads !== null;
  const expiryChoices = allowedExpiryOptions(maxExpiry).filter(
    (o) => o.value !== "never",
  );
  const capIsFinite =
    maxExpiry !== "" && maxExpiry !== "never" && expiryChoices.length > 0;
  const expiryWhenOn = clampExpiry(defaultExpiry || "7d", maxExpiry);

  // The toggle cannot be derived from the value, since it has to stay on while
  // the field is still empty.
  const [pwEnabled, setPwEnabled] = useState(password !== "");

  return (
    <Stack gap="lg" w="100%">
      <Text fw={600}>{t("settings.title")}</Text>

      <Group justify="space-between" wrap="nowrap" gap="md">
        <Switch
          label={t("settings.expiresAfter")}
          checked={expires}
          onChange={(e) =>
            onExpiryChange(e.currentTarget.checked ? expiryWhenOn : "never")
          }
          // A finite cap does not allow "never".
          disabled={uploading || capIsFinite}
        />
        <Select
          w={CONTROL_W}
          value={expires ? expiry : expiryWhenOn}
          onChange={(v) => v && onExpiryChange(v)}
          data={expiryChoices.map((o) => ({
            value: o.value,
            label: t(`expiry.${o.value}`),
          }))}
          allowDeselect={false}
          disabled={!expires || uploading}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>

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

      <Group justify="space-between" wrap="nowrap" gap="md">
        <Switch
          // The toggle already says it is optional, so the label's trailing
          // "(optional)" goes in every locale.
          label={t("settings.password").replace(/\s*\([^)]*\)\s*$/, "")}
          checked={pwEnabled}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setPwEnabled(on);
            if (!on) onPasswordChange("");
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

      {showMetadataStrip && (
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Switch
            label={t("settings.stripMetadata")}
            checked={stripMetadata}
            onChange={(e) => onStripMetadataChange(e.currentTarget.checked)}
            disabled={uploading}
          />
          <Text size="xs" c="dimmed" w={CONTROL_W}>
            {t("settings.stripMetadataHint")}
          </Text>
        </Group>
      )}

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
