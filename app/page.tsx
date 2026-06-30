"use client";

import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Box,
  Center,
  Container,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  Tooltip,
  Transition,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import * as tus from "tus-js-client";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ResultPanel } from "@/components/ResultPanel";
import { UploadGate } from "@/components/UploadGate";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { EXPIRY_OPTIONS } from "@/lib/expiry";
import { filesFromDropEvent } from "@/lib/dropped-files";
import { formatBytes } from "@/lib/format";
import { useServerConfig } from "@/components/ServerConfigProvider";
import { uploadEncrypted, type UploadDeps } from "@/lib/e2e/upload-flow";

// Header the client attaches the upload secret to (mirrors lib/upload-auth.ts).
// Kept in sync there for the server side; duplicated here so this client module
// has no server-only import.
const UPLOAD_TOKEN_HEADER = "x-fd-upload-token";
// sessionStorage key for the entered upload secret — survives the tab session,
// gone when the tab closes. Memory-only would be lost on navigation; we never
// persist it to localStorage.
const UPLOAD_TOKEN_STORAGE_KEY = "fd-upload-token";

// Recognize a 401 from either write path (tus upload or finalize) so the UI can
// re-prompt for the upload password instead of showing a generic failure.
function isUploadAuthError(err: unknown): boolean {
  if (err instanceof tus.DetailedError) {
    return err.originalResponse?.getStatus() === 401;
  }
  return err instanceof Error && err.message === "finalize 401";
}

// "encrypting" is a client-side phase before the actual network upload starts.
type Status = "idle" | "ready" | "encrypting" | "uploading" | "done";

export default function HomePage() {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { baseUrl, uploadProtected } = useServerConfig();
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

  // Hidden file input — the ONLY <input type="file"> on the page. The big Logo
  // is the visible affordance and forwards its click here; e2e drives uploads by
  // calling setInputFiles() on this element. `multiple` keeps multi-file uploads
  // (and the multi-file e2e scenario) working.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Page-wide drag feedback: dim the page subtly while a drag hovers anywhere.
  const [dragging, setDragging] = useState(false);

  // Upload gate (only relevant when the instance sets UPLOAD_PASSWORD, surfaced
  // as `uploadProtected`). The operator's secret never reaches the client config;
  // the user types it once and we keep it for the tab session (sessionStorage) so
  // they don't re-enter it per upload. `gateError` shows a wrong-password retry.
  const [uploadToken, setUploadToken] = useState<string>("");
  const [gateError, setGateError] = useState<string>("");
  useEffect(() => {
    if (!uploadProtected) return;
    try {
      const saved = sessionStorage.getItem(UPLOAD_TOKEN_STORAGE_KEY);
      if (saved) setUploadToken(saved);
    } catch {
      // sessionStorage can throw (e.g. privacy mode) — fall back to memory only.
    }
  }, [uploadProtected]);

  const unlockUpload = (token: string) => {
    setUploadToken(token);
    setGateError("");
    try {
      sessionStorage.setItem(UPLOAD_TOKEN_STORAGE_KEY, token);
    } catch {
      // Non-persistent fallback: token stays in memory for this page only.
    }
  };

  // Re-lock the gate after a rejected secret so the user re-enters it.
  const clearUploadToken = () => {
    setUploadToken("");
    try {
      sessionStorage.removeItem(UPLOAD_TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // The gate blocks uploading until the user has entered a secret. An entered
  // secret may still be wrong — that surfaces as gateError after a 401 retry.
  const uploadLocked = uploadProtected && uploadToken === "";

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
    // Clear the native input so re-picking the same file fires `change` again.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // The upload is "in progress" during both the encrypt and upload phases.
  const uploading = status === "uploading" || status === "encrypting";
  const showPanel = status === "ready" || uploading;

  // Clicking the big Logo opens the native file picker (unless an upload runs or
  // the gate is locked). The hidden input's onChange routes the selection
  // through the same onDrop(files) path as a drag-drop.
  const openPicker = () => {
    if (uploading || uploadLocked) return;
    fileInputRef.current?.click();
  };

  // Page-level drag-and-drop: dropping files ANYWHERE selects them. We read the
  // flat FileList via filesFromDropEvent (NOT webkitGetAsEntry) to avoid the
  // Chromium/Edge renderer crash (issue #4); folders are never expanded.
  const onPageDragOver = (e: React.DragEvent) => {
    if (uploading || uploadLocked) return;
    // Only react to file drags (ignore text/element drags) and allow the drop.
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      if (!dragging) setDragging(true);
    }
  };
  const onPageDragLeave = (e: React.DragEvent) => {
    // Only clear when the cursor actually left the container, not when moving
    // between children (relatedTarget still inside the container).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragging(false);
    }
  };
  const onPageDrop = (e: React.DragEvent) => {
    setDragging(false);
    if (uploading || uploadLocked) return;
    const dropped = filesFromDropEvent(e);
    if (dropped.length > 0) {
      e.preventDefault();
      onDrop(dropped);
    }
  };

  const startUpload = () => {
    if (files.length === 0) return;
    setStatus("encrypting");
    setProgress(0);

    // When the instance gates uploads, attach the operator's secret to both
    // write paths via the `x-fd-upload-token` header. Empty when not protected,
    // so the header is simply omitted and the flow is exactly as today.
    const authHeaders: Record<string, string> = uploadToken
      ? { [UPLOAD_TOKEN_HEADER]: uploadToken }
      : {};

    // Build the UploadDeps that uploadEncrypted injects for tus and finalize.
    const deps: UploadDeps = {
      upload(scratchFile, onProgress) {
        return new Promise<string>((resolve, reject) => {
          const upload = new tus.Upload(scratchFile, {
            endpoint: "/files",
            retryDelays: [0, 1000, 3000, 5000],
            headers: authHeaders,
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
          headers: { "Content-Type": "application/json", ...authHeaders },
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
        // A 401 from either write path means the upload password was wrong (or
        // missing) — re-lock the gate, show the retry hint, no generic error.
        if (uploadProtected && isUploadAuthError(e)) {
          clearUploadToken();
          setGateError(t("uploadGate.wrongPassword"));
          return;
        }
        notifications.show({
          color: "red",
          title: t("upload.failed"),
          message: e instanceof Error ? e.message : "unknown error",
        });
      });
  };

  const expiryOpt = EXPIRY_OPTIONS.find((o) => o.value === expiry);
  const expiryText =
    expiryOpt?.value === "never"
      ? t("result.neverExpires")
      : t("result.expiresAfter", { label: t(`expiry.${expiry}`) });

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <Container
      size="lg"
      py={48}
      style={{ position: "relative", minHeight: "100vh" }}
      onDragOver={onPageDragOver}
      onDragLeave={onPageDragLeave}
      onDrop={onPageDrop}
    >
      {/* Hidden, multiple file input — the page's single input[type=file]. The
          big Logo forwards its click here; e2e sets files directly on it. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = filesFromDropEvent(e);
          if (picked.length > 0) onDrop(picked);
        }}
      />

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

      {/* Tagline pinned to the VERY TOP, clean — the page text lives up here so
          the centre belongs entirely to the big, reactive feather. */}
      <Stack align="center" gap={4} mb={8} mt={8} px="md">
        <Text fw={500} ta="center" style={{ fontSize: "clamp(1.1rem, 2.4vw, 1.5rem)", letterSpacing: -0.3 }}>
          {t("app.tagline")}
        </Text>
        <Text c="dimmed" size="sm" ta="center">
          {t("app.privacy")}
        </Text>
      </Stack>

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
        <Stack align="center" gap="lg">
          {/* The big, reactive feather IS the upload affordance (Smash-style):
              clicking it ALWAYS opens the file picker (so it adds or replaces the
              selection — it never silently discards chosen files); dragging files
              anywhere on the page drops them. The wordmark sits quietly beneath.
              Starting over from the "ready" state is just re-picking files. */}
          <UnstyledButton
            onClick={openPicker}
            aria-label={t("settings.upload")}
            disabled={uploading}
            style={{ cursor: uploading ? "default" : "pointer" }}
          >
            <Stack align="center" gap={8}>
              <Box
                style={{
                  transform: dragging ? "scale(1.06)" : "scale(1)",
                  transition: "transform 180ms ease, filter 180ms ease",
                  // Glow uses the accent token (fdgold step 6 = the base accent,
                  // #d4af37 by default) so a custom ACCENT_COLOR stays consistent;
                  // color-mix adds the alpha the bare token can't carry.
                  filter: dragging
                    ? "drop-shadow(0 0 28px color-mix(in srgb, var(--mantine-color-fdgold-6) 55%, transparent))"
                    : "drop-shadow(0 0 0 transparent)",
                }}
                className="fd-hero-logo"
              >
                <Logo size={300} cssSize="clamp(120px, 26vw, 300px)" />
              </Box>
              <Title
                order={1}
                fw={500}
                style={{
                  fontSize: "clamp(1.5rem, 4vw, 2.25rem)",
                  letterSpacing: -1,
                  fontFamily: "var(--font-bitter), Georgia, serif",
                  fontStyle: "italic",
                }}
              >
                {appName}
              </Title>
            </Stack>
          </UnstyledButton>

          {/* Hint under the feather — what clicking/dragging does. In the idle
              state it explains the upload affordance; once files are chosen it
              tells the user the feather still opens the picker to replace them, so
              the prominent click target is never an undiscoverable surprise. */}
          {!uploading && !uploadLocked && (
            <Text c="dimmed" size="sm" ta="center">
              {status === "idle"
                ? `${t("drop.drag")} · ${t("drop.browse")}`
                : files.length > 1
                  ? t("drop.replaceMulti")
                  : t("drop.replace")}
            </Text>
          )}

          {/* Upload progress lives near the logo now that the dropzone box (which
              used to host the ring) is gone — a clean full-width bar. */}
          {uploading && (
            <Stack align="center" gap={6} w="100%" maw={480}>
              <Progress
                value={progress}
                size="lg"
                radius="xl"
                w="100%"
                color="fdgold"
                striped
                animated
                aria-label={t("settings.upload")}
              />
              <Text c="dimmed" size="sm" ta="center">
                {status === "encrypting"
                  ? t("upload.encrypting")
                  : `${Math.round(progress)}%`}
              </Text>
            </Stack>
          )}

          {/* When the instance gates uploads (UPLOAD_PASSWORD set) and the user
              has not entered a valid secret yet, the upload password gate is
              shown — uploading cannot start until it is unlocked. */}
          {uploadLocked ? (
            <Paper radius="lg" p="xl" w="100%" maw={460} className="fd-glass">
              <Center>
                <UploadGate onUnlock={unlockUpload} error={gateError} />
              </Center>
            </Paper>
          ) : (
            <Transition mounted={showPanel} transition="pop" duration={200}>
              {(styles) => (
                <Paper
                  radius="lg"
                  p="xl"
                  w="100%"
                  maw={460}
                  className="fd-glass"
                  style={styles}
                >
                  <Stack gap="md">
                    {/* Chosen-files summary — replaces the old dropzone's file
                        list so the user still sees what they picked. */}
                    {files.length > 0 && (
                      <Text size="sm" ta="center" c="dimmed">
                        {files.length === 1
                          ? `${files[0].name} · ${formatBytes(files[0].size)}`
                          : `${t("drop.fileCount", {
                              count: files.length,
                            })} · ${t("drop.total", {
                              size: formatBytes(totalSize),
                            })}`}
                      </Text>
                    )}
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
                  </Stack>
                </Paper>
              )}
            </Transition>
          )}
        </Stack>
      )}
    </Container>
  );
}
