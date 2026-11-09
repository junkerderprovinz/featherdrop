// Writes an encrypted note: a format 4 share the server cannot tell from a
// small file.
import { useState } from "react";
import { Button, Center, NumberInput, PasswordInput, Stack, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/Logo";
import { LinkField } from "@/components/LinkField";
import { ExpirySelect } from "@/components/ExpirySelect";
import { useServerConfig } from "@/components/ServerConfigProvider";
import { clampExpiry } from "@/lib/expiry";
import { MAX_NOTE_BYTES, uploadNote } from "@/lib/e2e/note";
import { storedUploadToken } from "@/lib/tus-upload";
import { tusUpload } from "@/lib/e2e/tus-upload";
import { cryptoWorker } from "@/lib/e2e/v2/crypto-worker";

// A UTF-16 code unit takes at most three bytes in UTF-8.
const MAX_NOTE_CHARS = Math.floor(MAX_NOTE_BYTES / 3);

export function NotePage() {
  const { t } = useTranslation();
  const { baseUrl, defaultExpiry, maxExpiry } = useServerConfig();
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState<string>(() => clampExpiry(defaultExpiry || "7d", maxExpiry));
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState<number | string>("");
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<{ shareUrl: string; manageUrl: string } | null>(null);

  const share = async () => {
    setBusy(true);
    const token = storedUploadToken();
    const auth: Record<string, string> = token ? { "x-fd-upload-token": token } : {};
    try {
      setLinks(
        await uploadNote(
          text,
          { expiry, maxDownloads: typeof maxDownloads === "number" ? maxDownloads : null, password: password || undefined },
          {
            baseUrl,
            crypto: cryptoWorker,
            upload: (source, { onProgress }) => tusUpload(source, { headers: auth, onProgress }),
            finalize: async (body) => {
              const res = await fetch("/api/finalize", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...auth },
                body: JSON.stringify(body),
              });
              if (!res.ok) throw new Error(`finalize ${res.status}`);
              return res.json() as Promise<{ slug: string }>;
            },
          },
        ),
      );
    } catch (e) {
      notifications.show({ color: "red", title: t("upload.failed"), message: e instanceof Error ? e.message : "" });
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
          {t("note.write")}
        </Title>
        {links ? (
          <>
            <LinkField label={t("result.ready")} value={links.shareUrl} />
            <LinkField label={t("result.manageTitle")} value={links.manageUrl} />
          </>
        ) : (
          <>
            <Textarea
              aria-label={t("note.write")}
              placeholder={t("note.placeholder")}
              autosize
              minRows={6}
              maxRows={18}
              maxLength={MAX_NOTE_CHARS}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <ExpirySelect value={expiry} onChange={setExpiry} />
            <NumberInput label={t("settings.maxDownloads")} min={1} value={maxDownloads} onChange={setMaxDownloads} />
            <PasswordInput
              label={t("settings.password")}
              placeholder={t("settings.passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <Button loading={busy} disabled={text.length === 0} onClick={() => void share()}>
              {t("note.share")}
            </Button>
          </>
        )}
      </Stack>
    </Center>
  );
}
