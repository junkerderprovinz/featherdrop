"use client";

import { useRef, useState } from "react";
import {
  ActionIcon,
  Box,
  Center,
  Container,
  Flex,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
  Transition,
  UnstyledButton,
  rem,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import * as tus from "tus-js-client";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { DropArea } from "@/components/DropArea";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ResultPanel } from "@/components/ResultPanel";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { EXPIRY_OPTIONS } from "@/lib/expiry";

type Status = "idle" | "ready" | "uploading" | "done";

export default function HomePage() {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { setColorScheme } = useMantineColorScheme();
  // Resolve "auto" to the actually-displayed scheme so the first click always
  // flips what the user sees (using the raw colorScheme, which starts as "auto",
  // makes the first toggle a no-op when it matches the system theme).
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });
  const [status, setStatus] = useState<Status>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [expiry, setExpiry] = useState("7d");
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState<number | null>(null);
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
    setMaxDownloads(null);
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
            body: JSON.stringify({ uploadId, expiry, password, maxDownloads }),
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
    <Container size="lg" py={60} style={{ position: "relative", minHeight: "100vh" }}>
      {/* Controls float top-right so the brand can sit centered like the rest. */}
      <Box pos="absolute" top={24} right={24} style={{ zIndex: 2 }}>
        <Group gap="xs">
          <LanguageSwitcher />
          <Tooltip label={t("theme.toggle")} withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("theme.toggle")}
              onClick={() =>
                setColorScheme(computedColorScheme === "dark" ? "light" : "dark")
              }
            >
              {computedColorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>

      {/* Clicking the brand returns to the start screen (resets any upload). */}
      <Center mb={88}>
        <UnstyledButton onClick={reset} aria-label={t("app.tagline")}>
          <Group gap="sm" style={{ cursor: "pointer" }}>
            <Logo size={52} />
            <Title
              order={1}
              fw={500}
              style={{
                fontSize: rem(32),
                letterSpacing: -1,
                fontFamily: "var(--font-bitter), Georgia, serif",
                fontStyle: "italic",
              }}
            >
              {appName}
            </Title>
          </Group>
        </UnstyledButton>
      </Center>

      {status === "done" ? (
        <ResultPanel url={shareUrl} expiryLabel={expiryText} onReset={reset} />
      ) : (
        <Stack align="center" gap={0}>
          <Stack align="center" gap={6} mb={36}>
            <Text fw={700} size={rem(28)} ta="center" style={{ letterSpacing: -0.5 }}>
              {t("app.tagline")}
            </Text>
            <Text c="dimmed" size="md" ta="center">
              {t("app.privacy")}
            </Text>
          </Stack>

          {/* Floating frosted-glass window holding the drop zone + settings. */}
          <Paper radius="lg" p="xl" w="100%" maw={860} className="fd-glass">
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
                      maxDownloads={maxDownloads}
                      onMaxDownloadsChange={setMaxDownloads}
                      onUpload={startUpload}
                      uploading={uploading}
                    />
                  </div>
                )}
              </Transition>
            </Flex>
          </Paper>
        </Stack>
      )}
    </Container>
  );
}
