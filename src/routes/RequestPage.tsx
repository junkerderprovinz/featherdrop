// Opens a file request and hands out its two links: the request link for
// whoever sends, the collect link for the requester alone.
import { useState } from "react";
import { Button, Center, NumberInput, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/Logo";
import { LinkField } from "@/components/LinkField";
import { ExpirySelect } from "@/components/ExpirySelect";
import { useServerConfig } from "@/components/ServerConfigProvider";
import { clampExpiry } from "@/lib/expiry";
import { createRequest } from "@/lib/e2e/request-flow";
import { storedUploadToken } from "@/lib/tus-upload";

export function RequestPage() {
  const { t } = useTranslation();
  const { baseUrl, defaultExpiry, maxExpiry } = useServerConfig();
  const [expiry, setExpiry] = useState<string>(() => clampExpiry(defaultExpiry || "7d", maxExpiry));
  const [maxUploads, setMaxUploads] = useState<number | string>("");
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<{ requestUrl: string; collectUrl: string } | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      setLinks(
        await createRequest(
          { expiry, maxUploads: typeof maxUploads === "number" ? maxUploads : null, maxSize: null },
          { baseUrl, uploadToken: storedUploadToken() },
        ),
      );
    } catch (e) {
      notifications.show({ color: "red", message: e instanceof Error ? e.message : "" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Stack gap="md" w="100%" maw={560}>
        <Center>
          <Logo size={40} />
        </Center>
        <Title order={2} ta="center">
          {t("request.title")}
        </Title>
        <Text c="dimmed" ta="center">
          {t("request.intro")}
        </Text>
        {links ? (
          <>
            <LinkField label={t("request.sendLink")} value={links.requestUrl} />
            <LinkField label={t("request.collectLink")} value={links.collectUrl} />
          </>
        ) : (
          <>
            <ExpirySelect value={expiry} onChange={setExpiry} />
            <NumberInput label={t("request.maxUploads")} min={1} value={maxUploads} onChange={setMaxUploads} />
            <Button loading={busy} onClick={() => void create()}>
              {t("request.create")}
            </Button>
          </>
        )}
      </Stack>
    </Center>
  );
}
