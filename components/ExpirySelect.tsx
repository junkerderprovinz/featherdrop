// The expiry choice of the note and request pages, limited by MAX_EXPIRY.
import { Select } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { allowedExpiryOptions } from "@/lib/expiry";
import { useServerConfig } from "@/components/ServerConfigProvider";

export function ExpirySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const { maxExpiry } = useServerConfig();
  return (
    <Select
      label={t("settings.expiresAfter")}
      data={allowedExpiryOptions(maxExpiry).map((o) => ({ value: o.value, label: t(`expiry.${o.value}`) }))}
      value={value}
      onChange={(v) => v && onChange(v)}
      allowDeselect={false}
    />
  );
}
