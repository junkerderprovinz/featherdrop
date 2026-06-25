"use client";

import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
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
import { IconAlertTriangle, IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import * as tus from "tus-js-client";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { DropArea } from "@/components/DropArea";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ResultPanel } from "@/components/ResultPanel";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { EXPIRY_OPTIONS } from "@/lib/expiry";
import { useServerConfig } from "@/components/ServerConfigProvider";
import { uploadEncrypted, type UploadDeps } from "@/lib/e2e/upload-flow";

// "encrypting" is a client-side phase before the actual network upload starts.
type Status = "idle" | "ready" | "encrypting" | "uploading" | "done";

export default function HomePage() {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { baseUrl } = useServerConfig();
  const { setColorScheme } = useMantineColorScheme();
  // Resolve "auto" to the actually-displayed scheme so the first click always
  // flips what the user sees (using the raw colorScheme, which starts as "auto",
  // makes the first toggle a no-op when it matches the system theme).
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });
  const [status, setStatus] = useState<Status>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [expiry, setExpiry] = useState("7d");
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState<number | null>(null);
  const [shareUrl, setShareUrl] = useState<string>("");

  // Over a plain-HTTP origin (e.g. opened by IP), the browser treats the page as
  // an insecure context: OPFS and the download service worker are unavailable,
  // so large uploads fall back to memory (capped) and streamed downloads are off.
  // Surface this instead of letting features silently degrade.
  const [insecure, setInsecure] = useState(false);
  useEffect(() => {
    setInsecure(typeof window !== "undefined" && !window.isSecureContext);
  }, []);

  const onDrop = (dropped: File[]) => {
    if (dropped.length === 0) return;
    setFiles(dropped);
    setStatus("ready");
  };

  const reset = () => {
    setFiles([]);
    setShareUrl("");
    setProgress(0);
    setPassword("");
    setExpiry("7d");
    setMaxDownloads(null);
    setStatus("idle");
  };

  const startUpload = () => {
    if (files.length === 0) return;
    setStatus("encrypting");
    setProgress(0);

    // Build the UploadDeps that uploadEncrypted injects for tus and finalize.
    const deps: UploadDeps = {
      upload(scratchFile, onProgress) {
        return new Promise<string>((resolve, reject) => {
          const upload = new tus.Upload(scratchFile, {
            endpoint: "/files",
            retryDelays: [0, 1000, 3000, 5000],
            // Name/type are encrypted inside the blob — do NOT send them to tus.
            onError: (err) => reject(err),
            onProgress: (sent, total) => onProgress(sent, total),
            onSuccess: () => {
              const uploadId = upload.url?.split("/").pop();
              if (!uploadId) {
                reject(new Error("tus upload missing URL"));
                return;
              }
              resolve(uploadId);
            },
          });
          upload.start();
        });
      },
      finalize(body) {
        return fetch("/api/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`finalize ${res.status}`);
          return res.json() as Promise<{ slug: string }>;
        });
      },
      baseUrl,
    };

    uploadEncrypted(
      files,
      { expiry, maxDownloads, password: password || undefined },
      deps,
      (phase, fraction) => {
        if (phase === "encrypting") {
          setStatus("encrypting");
          // Show a 0–50 % range for the encrypt phase so the bar moves.
          setProgress(fraction * 50);
        } else {
          setStatus("uploading");
          // Map upload fraction to 50–100 % so the bar continues smoothly.
          setProgress(50 + fraction * 50);
        }
      },
    )
      .then(({ shareUrl: url }) => {
        setShareUrl(url);
        setStatus("done");
      })
      .catch((e: unknown) => {
        setStatus("ready");
        notifications.show({
          color: "red",
          title: t("upload.failed"),
          message: e instanceof Error ? e.message : "unknown error",
        });
      });
  };

  // The upload is "in progress" during both the encrypt and upload phases.
  const uploading = status === "uploading" || status === "encrypting";
  const showPanel = status === "ready" || uploading;

  const expiryOpt = EXPIRY_OPTIONS.find((o) => o.value === expiry);
  const expiryText =
    expiryOpt?.value === "never"
      ? t("result.neverExpires")
      : t("result.expiresAfter", { label: t(`expiry.${expiry}`) });

  return (
    <Container size="lg" py={60} style={{ position: "relative", minHeight: "100vh" }}>
      {/* Controls pinned to the viewport top-right so they sit at the exact same
          spot on every page, independent of each page's Container width. */}
      <Box pos="fixed" top={24} right={24} style={{ zIndex: 2 }}>
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

      {insecure && (
        <Center mb={24}>
          <Alert
            variant="light"
            color="yellow"
            icon={<IconAlertTriangle size={18} />}
            maw={860}
            w="100%"
          >
            {t("insecure.warning")}
          </Alert>
        </Center>
      )}

      {status === "done" ? (
        <ResultPanel url={shareUrl} expiryLabel={expiryText} onReset={reset} />
      ) : (
        <Stack align="center" gap={0}>
          <Stack align="center" gap={6} mb={36}>
            <Text fw={500} size={rem(26)} ta="center" style={{ letterSpacing: -0.3 }}>
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
                files={files}
                phaseLabel={status === "encrypting" ? t("upload.encrypting") : undefined}
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
