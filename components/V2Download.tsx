// The download panel of a v2 share. The link token alone selects it, so a
// server reporting another format cannot move a v2 link onto an older path,
// and the password only ever enters the key schedule in this browser.

import { useEffect, useState } from "react";
import { ActionIcon, Box, Button, Group, PasswordInput, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconFile, IconFiles, IconLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/format";
import { decodeToken, type ShareKeys } from "@/lib/e2e/v2/keys";
import { openLink, fetchLinkListing, type ListedFile } from "@/lib/e2e/share-listing";
import { downloadDecryptedV2, downloadFileV2, fetchShareBlob } from "@/lib/e2e/download-flow";
import { canStreamDownload, streamToDownload, blobDownload } from "@/lib/e2e/stream-download";

function tokenMode(token: string) {
  try {
    return decodeToken(token).mode;
  } catch {
    return null;
  }
}

async function openShare(slug: string, token: string, format: number, password?: string) {
  const link = await openLink(token, format, password);
  if (link.format !== 4) throw new Error("v2: not a v2 link");
  const files = await fetchLinkListing(slug, link);
  return { keys: link.keys, files };
}

async function save(plaintext: ReadableStream<Uint8Array>, name: string, size: number): Promise<void> {
  if (canStreamDownload()) {
    await streamToDownload(plaintext, name, size);
  } else {
    blobDownload(await new Response(plaintext).blob(), name);
  }
}

interface V2DownloadProps {
  slug: string;
  format: number;
  token: string;
  /** A share with a download limit is one unit, so its files cannot be picked one by one. */
  limited: boolean;
  /** Called with the decrypted file list once the header is open. */
  onFiles: (files: ListedFile[]) => void;
}

export function V2Download({ slug, format, token, limited, onFiles }: V2DownloadProps) {
  const { t } = useTranslation();
  const mode = tokenMode(token);
  const [password, setPassword] = useState("");
  const [keys, setKeys] = useState<ShareKeys | null>(null);
  const [files, setFiles] = useState<ListedFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingFile, setSavingFile] = useState<number | null>(null);

  // A link share lists its files from the uncounted header right away.
  useEffect(() => {
    if (mode !== "link") return;
    let cancelled = false;
    void (async () => {
      try {
        const opened = await openShare(slug, token, format);
        if (cancelled) return;
        setKeys(opened.keys);
        setFiles(opened.files);
        onFiles(opened.files);
      } catch {
        // The download button tries again and reports the error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, slug, token, format, onFiles]);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    let current = keys;
    try {
      if (!current) {
        const opened = await openShare(slug, token, format, mode === "link+password" ? password : undefined);
        current = opened.keys;
        setKeys(current);
        setFiles(opened.files);
        onFiles(opened.files);
      }
    } catch {
      // A wrong password gives a verifier the header route refuses.
      notifications.show({
        color: "red",
        message: mode === "link+password" ? t("download.wrongPassword") : t("download.failed"),
      });
      setBusy(false);
      return;
    }
    try {
      await downloadDecryptedV2(fetchShareBlob(slug), { keys: current }, save, `${slug}.zip`);
    } catch {
      notifications.show({ color: "red", message: t("download.failed") });
    } finally {
      setBusy(false);
    }
  };

  const downloadOne = async (index: number) => {
    if (!keys || busy || savingFile !== null) return;
    setSavingFile(index);
    try {
      await downloadFileV2(slug, keys, index, save);
    } catch {
      notifications.show({ color: "red", message: t("download.failed") });
    } finally {
      setSavingFile(null);
    }
  };

  if (mode === null) {
    return (
      <Text c="red" ta="center" size="sm">
        {t("download.missingKey")}
      </Text>
    );
  }

  const locked = mode === "link+password" && !keys;
  const several = files !== null && files.length > 1;
  return (
    <Stack w="100%" gap="md">
      {several && (
        <Stack w="100%" gap={4}>
          {files.map((f, i) => (
            <Group key={`${f.name}-${i}`} justify="space-between" wrap="nowrap" gap="sm">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <IconFile size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
                <Box style={{ minWidth: 0 }}>
                  <Text size="sm" truncate>
                    {f.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatBytes(f.size ?? 0)}
                  </Text>
                </Box>
              </Group>
              {!limited && keys && (
                <Tooltip label={t("download.download")} withArrow>
                  <ActionIcon
                    variant="subtle"
                    style={{ flexShrink: 0 }}
                    aria-label={t("download.download")}
                    loading={savingFile === i}
                    disabled={busy || (savingFile !== null && savingFile !== i)}
                    onClick={() => void downloadOne(i)}
                  >
                    <IconDownload size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {locked && (
        <PasswordInput
          label={t("download.protected")}
          placeholder={t("download.passwordPlaceholder")}
          leftSection={<IconLock size={16} />}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void download()}
        />
      )}
      <Button
        fullWidth
        size="md"
        leftSection={several ? <IconFiles size={18} /> : <IconDownload size={18} />}
        loading={busy}
        disabled={savingFile !== null}
        onClick={() => void download()}

      >
        {locked ? t("download.unlock") : several ? t("download.downloadAll") : t("download.download")}
      </Button>
    </Stack>
  );
}
