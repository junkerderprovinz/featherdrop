// The page behind a collect link: lists what was sent to a request, saves it,
// shows notes and closes the request. The collect link's secret never leaves
// this browser. Only a token derived from it does.
import { useEffect, useState } from "react";
import { Button, Center, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconNote, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/Logo";
import { LinkField } from "@/components/LinkField";
import { NoteView } from "@/components/NoteView";
import { formatBytes } from "@/lib/format";
import { downloadDecryptedV2 } from "@/lib/e2e/download-flow";
import { readNote } from "@/lib/e2e/note";
import { canStreamDownload, streamToDownload, blobDownload } from "@/lib/e2e/stream-download";
import {
  closeRequest,
  deleteRequestUpload,
  fetchUploadBlob,
  listRequestUploads,
  parseCollectUrl,
  requestUrl,
  type CollectLink,
  type CollectedUpload,
} from "@/lib/e2e/request-flow";
import { useServerConfig } from "@/components/ServerConfigProvider";

type Phase = "loading" | "ready" | "closing" | "closed" | "notfound";

function linkFromLocation(): CollectLink | null {
  try {
    return parseCollectUrl(window.location.href);
  } catch {
    return null;
  }
}

async function save(plaintext: ReadableStream<Uint8Array>, name: string): Promise<void> {
  if (canStreamDownload()) await streamToDownload(plaintext, name);
  else blobDownload(await new Response(plaintext).blob(), name);
}

type Readable = Extract<CollectedUpload, { readable: true }>;

// Anyone with the request link can send one whose key opens nothing, so it is
// shown apart, and deleting it is all there is to do.
function UnreadableUpload({ collect, upload, onDeleted }: { collect: CollectLink; upload: CollectedUpload; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteRequestUpload(collect, upload.id);
      onDeleted();
    } catch {
      notifications.show({ color: "red", message: t("manage.deleteFailed") });
      setBusy(false);
    }
  };
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          {t("collect.unreadable")}
        </Text>
        <Button color="red" variant="light" leftSection={<IconTrash size={18} />} loading={busy} onClick={() => void remove()}>
          {t("manage.delete")}
        </Button>
      </Stack>
    </Paper>
  );
}

function Upload({ collect, upload }: { collect: CollectLink; upload: Readable }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const isNote = upload.header.kind === "text";

  const open = async () => {
    setBusy(true);
    try {
      const fetchBlob = fetchUploadBlob(collect, upload.id);
      if (isNote) setNote(await readNote(fetchBlob, { keys: upload.keys }));
      else await downloadDecryptedV2(fetchBlob, { keys: upload.keys }, save);
    } catch {
      notifications.show({ color: "red", message: t("download.failed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          {new Date(upload.createdAt).toLocaleString(i18n.language)}
        </Text>
        {isNote ? (
          <Text fw={600}>{t("note.title")}</Text>
        ) : (
          upload.header.files.map((f, i) => (
            <Group key={`${f.name}-${i}`} justify="space-between" wrap="nowrap">
              <Text size="sm" truncate>
                {f.name}
              </Text>
              <Text size="xs" c="dimmed">
                {formatBytes(f.size)}
              </Text>
            </Group>
          ))
        )}
        {note !== null ? (
          <NoteView text={note} />
        ) : (
          <Button
            variant="light"
            leftSection={isNote ? <IconNote size={18} /> : <IconDownload size={18} />}
            loading={busy}
            onClick={() => void open()}
          >
            {isNote ? t("note.show") : t("download.download")}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

export function CollectPage() {
  const { t } = useTranslation();
  const { baseUrl } = useServerConfig();
  const [collect] = useState(linkFromLocation);
  const [phase, setPhase] = useState<Phase>(collect ? "loading" : "notfound");
  const [uploads, setUploads] = useState<CollectedUpload[]>([]);
  const [shareLink, setShareLink] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!collect) return;
    void requestUrl(baseUrl || window.location.origin, collect).then(setShareLink);
    listRequestUploads(collect).then(
      (c) => {
        setUploads(c.uploads);
        setPhase("ready");
      },
      () => setPhase("notfound"),
    );
  }, [collect, baseUrl]);

  const close = async () => {
    if (!collect) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setPhase("closing");
    try {
      await closeRequest(collect);
      setPhase("closed");
    } catch {
      setPhase("ready");
      setConfirming(false);
      notifications.show({ color: "red", message: t("manage.deleteFailed") });
    }
  };

  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Stack gap="md" w="100%" maw={560}>
        <Center>
          <Logo size={40} />
        </Center>
        <Title order={2} ta="center">
          {t("collect.title")}
        </Title>
        {phase === "notfound" && <Text ta="center">{t("request.notFound")}</Text>}
        {phase === "closed" && <Text ta="center">{t("collect.closed")}</Text>}
        {collect && (phase === "ready" || phase === "closing") && (
          <>
            {shareLink && <LinkField label={t("request.sendLink")} value={shareLink} />}
            {uploads.length === 0 && (
              <Text c="dimmed" ta="center">
                {t("collect.empty")}
              </Text>
            )}
            {uploads.map((u) =>
              u.readable ? (
                <Upload key={u.id} collect={collect} upload={u} />
              ) : (
                <UnreadableUpload
                  key={u.id}
                  collect={collect}
                  upload={u}
                  onDeleted={() => setUploads((list) => list.filter((x) => x.id !== u.id))}
                />
              ),
            )}
            <Button
              color="red"
              variant={confirming ? "filled" : "light"}
              leftSection={<IconTrash size={18} />}
              loading={phase === "closing"}
              onClick={() => void close()}
            >
              {confirming ? t("manage.confirmDelete") : t("collect.close")}
            </Button>
          </>
        )}
      </Stack>
    </Center>
  );
}
