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
import { EXPIRY_OPTIONS, clampExpiry } from "@/lib/expiry";
import { filesFromDropEvent } from "@/lib/dropped-files";
import { formatBytes } from "@/lib/format";
import { loadPrefs, savePrefs } from "@/lib/prefs";
import { isStrippableType, stripFileMetadata } from "@/lib/exif";
import { collectSharedFiles, isShareTargetLaunch } from "@/lib/share-target";
import { useServerConfig } from "@/components/ServerConfigProvider";
import { uploadEncrypted, type UploadDeps } from "@/lib/e2e/upload-flow";

// The same header as lib/upload-auth.ts, repeated so this module has no
// server-only import.
const UPLOAD_TOKEN_HEADER = "x-fd-upload-token";
// The upload secret lives in sessionStorage, which survives navigation but not
// closing the tab; it never goes to localStorage.
const UPLOAD_TOKEN_STORAGE_KEY = "fd-upload-token";

// A 401 from tus or finalize re-prompts for the upload password instead of
// showing a generic failure.
function isUploadAuthError(err: unknown): boolean {
  if (err instanceof tus.DetailedError) {
    return err.originalResponse?.getStatus() === 401;
  }
  return err instanceof Error && err.message === "finalize 401";
}

type Status = "idle" | "ready" | "encrypting" | "uploading" | "done";

export default function HomePage() {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { baseUrl, uploadProtected, defaultExpiry, maxExpiry } =
    useServerConfig();
  // The remembered preference, else DEFAULT_EXPIRY, else "7d", clamped to
  // MAX_EXPIRY.
  const initialPrefs = useRef(loadPrefs());
  const baseExpiry = clampExpiry(
    initialPrefs.current.expiry ?? defaultExpiry ?? "7d",
    maxExpiry,
  );
  const { setColorScheme } = useMantineColorScheme();
  // With the raw "auto" scheme the first toggle would do nothing when it
  // matches the system theme.
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });
  const [status, setStatus] = useState<Status>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [expiry, setExpiry] = useState<string>(baseExpiry);
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState<number | null>(
    initialPrefs.current.maxDownloads,
  );
  const [stripMetadata, setStripMetadata] = useState(
    initialPrefs.current.stripMetadata ?? true,
  );
  const [shareUrl, setShareUrl] = useState<string>("");

  useEffect(() => {
    savePrefs({ expiry, maxDownloads, stripMetadata });
  }, [expiry, maxDownloads, stripMetadata]);

  // The page's only file input. The Logo forwards its click here, and the e2e
  // tests call setInputFiles() on it.
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);

  // With UPLOAD_PASSWORD set, the user types the secret once per tab session.
  const [uploadToken, setUploadToken] = useState<string>("");
  const [gateError, setGateError] = useState<string>("");
  useEffect(() => {
    if (!uploadProtected) return;
    try {
      const saved = sessionStorage.getItem(UPLOAD_TOKEN_STORAGE_KEY);
      if (saved) setUploadToken(saved);
    } catch {
      // sessionStorage can throw in privacy mode; the token then stays in memory.
    }
  }, [uploadProtected]);

  const unlockUpload = (token: string) => {
    setUploadToken(token);
    setGateError("");
    try {
      sessionStorage.setItem(UPLOAD_TOKEN_STORAGE_KEY, token);
    } catch {
      // The token stays in memory for this page only.
    }
  };

  const clearUploadToken = () => {
    setUploadToken("");
    try {
      sessionStorage.removeItem(UPLOAD_TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // A wrong secret shows up as gateError after the 401.
  const uploadLocked = uploadProtected && uploadToken === "";

  // Over plain HTTP there is no OPFS and no service worker, so large uploads
  // are capped in memory and downloads do not stream. The page says so.
  const [insecure, setInsecure] = useState(false);
  useEffect(() => {
    setInsecure(typeof window !== "undefined" && !window.isSecureContext);
  }, []);

  // A share-sheet launch lands on /?shared=1 with the files in the worker's
  // cache.
  useEffect(() => {
    if (!isShareTargetLaunch()) return;
    void collectSharedFiles().then((shared) => {
      if (shared.length > 0) onDrop(shared);
      // Otherwise a reload would look like a new share.
      window.history.replaceState(null, "", "/");
    });
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
    setExpiry(baseExpiry);
    setStatus("idle");
    // Otherwise picking the same file again fires no change event.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const uploading = status === "uploading" || status === "encrypting";
  const showPanel = status === "ready" || uploading;

  const openPicker = () => {
    if (uploading || uploadLocked) return;
    fileInputRef.current?.click();
  };

  // Files dropped anywhere on the page are selected. filesFromDropEvent avoids
  // the webkitGetAsEntry renderer crash (#4).
  const onPageDragOver = (e: React.DragEvent) => {
    if (uploading || uploadLocked) return;
    // Text and element drags are ignored.
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      if (!dragging) setDragging(true);
    }
  };
  const onPageDragLeave = (e: React.DragEvent) => {
    // Moving between children also fires dragleave.
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

  // Pasting files anywhere, a screenshot for example, selects them, except
  // while the focus is in a text field such as the share password. The
  // listener sits on the document because a paste goes wherever focus is.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (uploading || uploadLocked || status === "done") return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      const pasted = Array.from(e.clipboardData?.files ?? []);
      if (pasted.length === 0) return;
      e.preventDefault();
      onDrop(pasted);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [uploading, uploadLocked, status]);

  const hasJpeg = files.some((f) => isStrippableType(f.type));

  const startUpload = async () => {
    if (files.length === 0) return;
    setStatus("encrypting");
    setProgress(0);

    // stripFileMetadata returns the original file when it fails, so this never
    // blocks an upload.
    let toUpload = files;
    if (stripMetadata && hasJpeg) {
      toUpload = await Promise.all(files.map((f) => stripFileMetadata(f)));
    }

    const authHeaders: Record<string, string> = uploadToken
      ? { [UPLOAD_TOKEN_HEADER]: uploadToken }
      : {};

    const deps: UploadDeps = {
      upload(scratchFile, onProgress) {
        return new Promise<string>((resolve, reject) => {
          const upload = new tus.Upload(scratchFile, {
            endpoint: "/files",
            // Without chunking the whole blob goes in one request, which a proxy
            // with a 100 MB cap such as Cloudflare rejects with 413, and a
            // dropped upload restarts from zero.
            chunkSize: 64 * 1024 * 1024,
            retryDelays: [0, 1000, 3000, 5000],
            headers: authHeaders,
            // No metadata: name and type are encrypted inside the blob.
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
      toUpload,
      { expiry, maxDownloads, password: password || undefined },
      deps,
      (phase, fraction) => {
        // Encrypting fills the first half of the bar, uploading the second.
        if (phase === "encrypting") {
          setStatus("encrypting");
          setProgress(fraction * 50);
        } else {
          setStatus("uploading");
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
        // A wrong or missing upload password locks the gate again.
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
      style={{
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
      onDragOver={onPageDragOver}
      onDragLeave={onPageDragLeave}
      onDrop={onPageDrop}
    >
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

      {/* Absolutely positioned so the feather below centres in the full
          viewport. */}
      <Box style={{ position: "absolute", top: 28, left: 24, right: 24, zIndex: 2 }}>
        <Box style={{ position: "relative", display: "flex", justifyContent: "center" }}>
          <Stack align="center" gap={4} px={72} style={{ maxWidth: "100%" }}>
            <Text
              fw={500}
              ta="center"
              style={{ fontSize: "clamp(1.1rem, 2.4vw, 1.5rem)", letterSpacing: -0.3 }}
            >
              {t("app.tagline")}
            </Text>
            <Text c="dimmed" size="sm" ta="center">
              {t("app.privacy")}
            </Text>
          </Stack>
          <Group
            gap="xs"
            align="center"
            style={{ position: "absolute", right: 0, top: 0, bottom: 0 }}
          >
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
      </Box>

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

      {/* The feather, the options panel and the result share one grid cell in
          the middle of the page, so they cross-fade into one another. */}
      <Box style={{ flex: 1, display: "grid", placeItems: "center", width: "100%" }}>
        {status === "done" ? (
          <ResultPanel url={shareUrl} expiryLabel={expiryText} onReset={reset} />
        ) : (
          <Box style={{ display: "grid", placeItems: "center", width: "100%" }}>
            <Transition
              mounted={!showPanel && !uploadLocked}
              transition="fade"
              duration={200}
            >
              {(styles) => (
                <Stack
                  align="center"
                  gap={8}
                  style={{ gridArea: "1 / 1", ...styles }}
                >
                  <UnstyledButton
                    onClick={openPicker}
                    // settings.upload names the real upload button; sharing the
                    // name would confuse screen readers and the e2e locators.
                    aria-label={t("drop.drag")}
                    disabled={uploading}
                    style={{ cursor: uploading ? "default" : "pointer" }}
                  >
                    {/* The feather glows on hover and while a file is dragged
                        over the page; see .fd-hero-logo and .fd-hero-text. */}
                    <Stack align="center" gap={8}>
                      <Box
                        className="fd-hero-logo"
                        data-dragging={dragging || undefined}
                      >
                        <Logo size={300} cssSize="clamp(120px, 26vw, 300px)" />
                      </Box>
                      <Title
                        order={1}
                        fw={500}
                        className="fd-hero-text"
                        style={{
                          fontSize: "clamp(1.5rem, 4vw, 2.25rem)",
                          letterSpacing: -1,
                          fontFamily: "var(--font-bitter), Georgia, serif",
                          fontStyle: "italic",
                        }}
                      >
                        {appName}
                      </Title>
                      <Text
                        c="dimmed"
                        size="sm"
                        ta="center"
                        mt={4}
                        className="fd-hero-text"
                      >
                        {`${t("drop.drag")} · ${t("drop.browse")}`}
                      </Text>
                    </Stack>
                  </UnstyledButton>
                </Stack>
              )}
            </Transition>

            <Transition mounted={uploadLocked} transition="pop" duration={200}>
              {(styles) => (
                <Paper
                  radius="lg"
                  p="xl"
                  w="100%"
                  maw={460}
                  className="fd-glass"
                  style={{ gridArea: "1 / 1", ...styles }}
                >
                  <Center>
                    <UploadGate onUnlock={unlockUpload} error={gateError} />
                  </Center>
                </Paper>
              )}
            </Transition>

            <Transition
              mounted={showPanel && !uploadLocked}
              transition="pop"
              duration={260}
            >
              {(styles) => (
                <Stack
                  align="center"
                  gap="md"
                  w="100%"
                  maw={460}
                  style={{ gridArea: "1 / 1", ...styles }}
                >
                  <Paper radius="lg" p="xl" w="100%" className="fd-glass">
                    <Stack gap="md">
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
                        onUpload={() => void startUpload()}
                        uploading={uploading}
                        maxExpiry={maxExpiry}
                        defaultExpiry={baseExpiry}
                        showMetadataStrip={hasJpeg}
                        stripMetadata={stripMetadata}
                        onStripMetadataChange={setStripMetadata}
                      />
                    </Stack>
                  </Paper>

                  {uploading && (
                    <Stack align="center" gap={6} w="100%">
                      <Progress
                        value={progress}
                        size="lg"
                        radius="xl"
                        w="100%"
                        color="fdgold"
                        striped
                        animated
                        aria-label={t("upload.encrypting")}
                      />
                      <Text c="dimmed" size="sm" ta="center">
                        {status === "encrypting"
                          ? t("upload.encrypting")
                          : `${Math.round(progress)}%`}
                      </Text>
                    </Stack>
                  )}
                </Stack>
              )}
            </Transition>
          </Box>
        )}
      </Box>
    </Container>
  );
}
