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
  const { baseUrl, uploadProtected, defaultExpiry, maxExpiry } =
    useServerConfig();
  // The expiry used when nothing else is chosen: the visitor's remembered
  // preference, else the operator's DEFAULT_EXPIRY, else "7d" — always clamped
  // to the operator's MAX_EXPIRY cap.
  const initialPrefs = useRef(loadPrefs());
  const baseExpiry = clampExpiry(
    initialPrefs.current.expiry ?? defaultExpiry ?? "7d",
    maxExpiry,
  );
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
  const [expiry, setExpiry] = useState<string>(baseExpiry);
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState<number | null>(
    initialPrefs.current.maxDownloads,
  );
  // Photo-metadata scrub (EXIF/GPS): remembered, default ON — privacy-first.
  const [stripMetadata, setStripMetadata] = useState(
    initialPrefs.current.stripMetadata ?? true,
  );
  const [shareUrl, setShareUrl] = useState<string>("");

  // Remember the last-used options (never the password) for the next visit.
  useEffect(() => {
    savePrefs({ expiry, maxDownloads, stripMetadata });
  }, [expiry, maxDownloads, stripMetadata]);

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

  // PWA share-target launch: the SW stashed the shared files and redirected to
  // /?shared=1 — collect them into the normal selection flow and clean the URL.
  useEffect(() => {
    if (!isShareTargetLaunch()) return;
    void collectSharedFiles().then((shared) => {
      if (shared.length > 0) onDrop(shared);
      // Drop the ?shared marker so a reload doesn't look like a new share.
      window.history.replaceState(null, "", "/");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Back to the resolved default (remembered preference / DEFAULT_EXPIRY) —
    // NOT a hardcoded value; the whole point of remembering options.
    setExpiry(baseExpiry);
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

  // Paste-to-upload: Ctrl/Cmd+V anywhere on the page drops the clipboard's
  // files (e.g. a screenshot) into the normal selection flow. Guards: never
  // while an upload runs or the gate is locked, and never when the user is
  // pasting INTO a text field (share password!). Uses document-level listening
  // because the paste target is wherever focus happens to be.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploading, uploadLocked, status]);

  const hasJpeg = files.some((f) => isStrippableType(f.type));

  const startUpload = async () => {
    if (files.length === 0) return;
    setStatus("encrypting");
    setProgress(0);

    // Photo-metadata scrub BEFORE encryption (browser-side by necessity — the
    // server only ever sees ciphertext). Failures fall back to the original
    // file inside stripFileMetadata; this never blocks an upload.
    let toUpload = files;
    if (stripMetadata && hasJpeg) {
      toUpload = await Promise.all(files.map((f) => stripFileMetadata(f)));
    }

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
            // Split the upload into <100 MB PATCH requests. Without this,
            // tus-js-client sends the whole (encrypted) blob in ONE request,
            // which a 100 MB-capped proxy/CDN (Cloudflare free/pro, incl. its
            // Tunnel) rejects with 413 — and a dropped upload would restart from
            // zero. 64 MiB stays safely under the cap and gives real resume.
            chunkSize: 64 * 1024 * 1024,
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
      toUpload,
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

      {/* Top band: the tagline is centred, and the language + theme controls sit
          on the right at the SAME height as the text. Absolutely positioned so it
          never pushes the feather down — the feather then centres in the FULL
          viewport (see the stage below). */}
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

      {/* The interactive stage fills the space under the tagline and CENTERS its
          active block in the viewport — so the feather, the options panel and the
          result card all sit in the middle of the page (consistent across every
          screen). The feather (idle), the options panel (a file is chosen) and the
          result share ONE grid cell, so they cross-fade into one another. */}
      <Box style={{ flex: 1, display: "grid", placeItems: "center", width: "100%" }}>
        {status === "done" ? (
          <ResultPanel url={shareUrl} expiryLabel={expiryText} onReset={reset} />
        ) : (
          <Box style={{ display: "grid", placeItems: "center", width: "100%" }}>
            {/* IDLE: the big, reactive feather IS the upload affordance — click
                opens the picker, dragging anywhere on the page drops files. */}
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
                    // NOT settings.upload: that is the real Upload-&-share button's
                    // name; two buttons sharing it breaks the e2e (strict-mode) +
                    // screen-reader clarity. This is the "choose files" affordance.
                    aria-label={t("drop.drag")}
                    disabled={uploading}
                    style={{ cursor: uploading ? "default" : "pointer" }}
                  >
                    {/* The feather and the two text lines react INDEPENDENTLY on
                        hover (see .fd-hero-logo / .fd-hero-text): the feather glows,
                        each text line grows a touch. The feather also glows while a
                        file is dragged over the page (data-dragging). */}
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

            {/* Upload-password gate (UPLOAD_PASSWORD set, not yet unlocked). */}
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

            {/* A file is chosen: the OPTIONS panel REPLACES the feather (same grid
                cell -> cross-fade + pop). The upload-progress bar sits BELOW the
                panel, not inside it. */}
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

                  {/* Progress BELOW the options window. */}
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
