"use client";

import { useRef, useState } from "react";
import {
  ActionIcon,
  Container,
  Flex,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
  Transition,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import * as tus from "tus-js-client";
import { Logo } from "@/components/Logo";
import { DropArea } from "@/components/DropArea";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ResultPanel } from "@/components/ResultPanel";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { EXPIRY_OPTIONS } from "@/lib/expiry";

type Status = "idle" | "ready" | "uploading" | "done";

export default function HomePage() {
  const { t } = useTranslation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [status, setStatus] = useState<Status>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [expiry, setExpiry] = useState("7d");
  const [password, setPassword] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  // Link-mode per-file key returned by finalize (only when no password). It is
  // appended to the share URL as a #fragment and never stored server-side.
  const [linkKey, setLinkKey] = useState<string | null>(null);
  const uploadRef = useRef<tus.Upload | null>(null);

  const onDrop = (f: File) => {
    setFile(f);
    setStatus("ready");
  };

  const reset = () => {
    setFile(null);
    setSlug(null);
    setLinkKey(null);
    setProgress(0);
    setPassword("");
    setExpiry("7d");
    setStatus("idle");
  };

  const startUpload = () => {
    if (!file) return;
    setStatus("uploading");
    setProgress(0);

    const upload = new tus.Upload(file, {
      endpoint: "/files",
      retryDelays: [0, 1000, 3000, 5000],
      metadata: { filename: file.name, filetype: file.type },
      onError: (err) => {
        setStatus("ready");
        notifications.show({
          color: "red",
          title: t("upload.failed"),
          message: err.message,
        });
      },
      onProgress: (sent, total) => setProgress((sent / total) * 100),
      onSuccess: async () => {
        try {
          const uploadId = upload.url?.split("/").pop();
          const res = await fetch("/api/finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId, expiry, password }),
          });
          if (!res.ok) throw new Error(`finalize ${res.status}`);
          const data = (await res.json()) as { slug: string; key?: string };
          setSlug(data.slug);
          setLinkKey(data.key ?? null);
          setStatus("done");
        } catch (e) {
          setStatus("ready");
          notifications.show({
            color: "red",
            title: t("upload.finalizeFailed"),
            message: e instanceof Error ? e.message : "unknown error",
          });
        }
      },
    });
    uploadRef.current = upload;
    upload.start();
  };

  const shareUrl =
    slug && typeof window !== "undefined"
      ? `${window.location.origin}/d/${slug}${linkKey ? `#k=${linkKey}` : ""}`
      : "";
  const uploading = status === "uploading";
  const showPanel = status === "ready" || status === "uploading";

  const expiryOpt = EXPIRY_OPTIONS.find((o) => o.value === expiry);
  const expiryText =
    expiryOpt?.value === "never"
      ? t("result.neverExpires")
      : t("result.expiresAfter", { label: t(`expiry.${expiry}`) });

  return (
    <Container size="lg" py={60} style={{ minHeight: "100vh" }}>
      <Group justify="space-between" mb={48}>
        <Group gap="xs">
          <Logo size={28} />
          <Title order={2} fw={800}>
            featherdrop
          </Title>
        </Group>
        <Group gap="xs">
          <LanguageSwitcher />
          <Tooltip label={t("theme.toggle")} withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("theme.toggle")}
              onClick={() =>
                setColorScheme(colorScheme === "dark" ? "light" : "dark")
              }
            >
              {colorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {status === "done" ? (
        <ResultPanel url={shareUrl} expiryLabel={expiryText} onReset={reset} />
      ) : (
        <Stack align="center" gap="sm">
          <Stack align="center" gap={2} mb="md">
            <Text fw={600} size="xl">
              {t("app.tagline")}
            </Text>
            <Text c="dimmed">{t("app.subtitle")}</Text>
          </Stack>

          <Paper withBorder radius="xl" p="lg" w="100%" maw={820}>
            <Flex
              direction={{ base: "column", sm: "row" }}
              gap="lg"
              align="stretch"
            >
              <DropArea
                onDrop={onDrop}
                uploading={uploading}
                progress={progress}
                fileName={file?.name}
                fileSize={file?.size}
              />
              <Transition mounted={showPanel} transition="slide-left" duration={200}>
                {(styles) => (
                  <div style={styles}>
                    <SettingsPanel
                      expiry={expiry}
                      onExpiryChange={setExpiry}
                      password={password}
                      onPasswordChange={setPassword}
                      onUpload={startUpload}
                      uploading={uploading}
                    />
                  </div>
                )}
              </Transition>
            </Flex>
          </Paper>

          <Text c="dimmed" size="xs" mt="xl">
            {t("app.footer")}
          </Text>
        </Stack>
      )}
    </Container>
  );
}
