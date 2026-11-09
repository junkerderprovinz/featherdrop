// The page behind a request link: pick files, they are encrypted here and
// sealed to the requester's key, and only the collect link opens them.
import { useEffect, useState } from "react";
import { Button, Center, FileInput, Progress, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/Logo";
import { formatBytes } from "@/lib/format";
import {
  fetchRequestInfo,
  parseRequestUrl,
  sendToRequest,
  RequestClosedError,
  RequestTooLargeError,
  type RequestLink,
} from "@/lib/e2e/request-flow";
import { tusUpload } from "@/lib/tus-upload";

type Phase = "loading" | "ready" | "sending" | "sent" | "closed" | "notfound";

function linkFromLocation(): RequestLink | null {
  try {
    return parseRequestUrl(window.location.href);
  } catch {
    return null;
  }
}

export function SendPage() {
  const { t } = useTranslation();
  const [link] = useState(linkFromLocation);
  const [phase, setPhase] = useState<Phase>(link ? "loading" : "notfound");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!link) return;
    fetchRequestInfo(link).then(
      (info) => setPhase(info.open ? "ready" : "closed"),
      () => setPhase("notfound"),
    );
  }, [link]);

  const send = async () => {
    if (!link || files.length === 0) return;
    setPhase("sending");
    try {
      await sendToRequest(files, link, { upload: tusUpload }, (step, fraction) =>
        setProgress(step === "encrypting" ? fraction * 50 : 50 + fraction * 50),
      );
      setPhase("sent");
    } catch (e) {
      if (e instanceof RequestClosedError) {
        setPhase("closed");
        return;
      }
      setPhase("ready");
      const message =
        e instanceof RequestTooLargeError
          ? t("request.tooLarge", { size: formatBytes(e.maxSize) })
          : t("upload.failed");
      notifications.show({ color: "red", message });
    }
  };

  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Stack gap="md" w="100%" maw={560}>
        <Center>
          <Logo size={40} />
        </Center>
        <Title order={2} ta="center">
          {t("request.sendTitle")}
        </Title>
        {phase === "notfound" && <Text ta="center">{t("request.notFound")}</Text>}
        {phase === "closed" && <Text ta="center">{t("request.closed")}</Text>}
        {phase === "sent" && <Text ta="center">{t("request.sent")}</Text>}
        {(phase === "ready" || phase === "sending") && (
          <>
            <Text c="dimmed" ta="center">
              {t("request.sendIntro")}
            </Text>
            <FileInput multiple value={files} onChange={setFiles} disabled={phase === "sending"} clearable />
            {phase === "sending" && <Progress value={progress} />}
            <Button loading={phase === "sending"} disabled={files.length === 0} onClick={() => void send()}>
              {t("request.send")}
            </Button>
          </>
        )}
      </Stack>
    </Center>
  );
}
