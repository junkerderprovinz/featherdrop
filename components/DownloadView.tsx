"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Code,
  Container,
  Divider,
  Group,
  Paper,
  PasswordInput,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
  rem,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFiles,
  IconFolder,
  IconLock,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes, describeExpiry } from "@/lib/format";
import {
  isPreviewableMime,
  isServerInlineMime,
  previewKind,
  type PreviewKind,
} from "@/lib/preview";
import { mimeFromName } from "@/lib/mime";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { downloadDecrypted, type DownloadSecret } from "@/lib/e2e/download-flow";
import { decryptFilesWithKey, type MultiDownload } from "@/lib/e2e/multi-pipeline";
import { deriveContentKey, decryptWithKey } from "@/lib/e2e/pipeline";
import { computeKeyVerifier, fromBase64 } from "@/lib/e2e/crypto";
import { peekBlobHeader } from "@/lib/e2e/blob-layout";
import { streamToAsyncIterable } from "@/lib/e2e/stream-adapters";
import type { Manifest } from "@/lib/e2e/multi-file";
import {
  canStreamDownload,
  streamToDownload,
  blobDownload,
} from "@/lib/e2e/stream-download";
import {
  canStreamPreview,
  registerVideoPreview,
  type PreviewHandle,
} from "@/lib/e2e/stream-preview";

// Format 2 shares preview entirely in the browser. Up to this size the file is
// decrypted into memory once, which serves both the preview and the later
// download without a second fetch; larger files stream straight to disk.
const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

// A giant log decoded into one <pre> would freeze the tab, so text has a much
// smaller cap on what is decoded and rendered.
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

// Format 3 bundles up to this size are decrypted once and buffered, so the list,
// "Download all" and every per-file button share one counted GET; the share
// counts as one unit. Larger bundles stream per save to keep memory bounded.
const MULTI_BUFFER_MAX_BYTES = 100 * 1024 * 1024;

interface BufferedFile {
  name: string;
  type: string;
  blob: Blob;
}

// Decodes an in-memory blob for a text preview, or returns null over the text
// cap so the caller shows the "too large" note.
async function decodeTextPreview(blob: Blob): Promise<string | null> {
  if (blob.size > TEXT_PREVIEW_MAX_BYTES) return null;
  const buf = await blob.arrayBuffer();
  // A mislabelled binary renders as garbled text instead of throwing.
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// The File System Access API is not in lib.dom yet; this is the part "Save to
// folder" uses, probed at runtime.
interface FsFileHandle {
  createWritable(): Promise<{
    write(data: BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}
interface FsDirHandle {
  getFileHandle(name: string, opts: { create: true }): Promise<FsFileHandle>;
}
type ShowDirectoryPicker = () => Promise<FsDirHandle>;

interface DownloadViewProps {
  slug: string;
  name: string | null; // null when encrypted
  size: number;
  mime: string | null;
  expiresAt: number | null;
  hasPassword: boolean;
  linkMode: boolean; // format 1: key in the URL fragment
  serverMode: boolean; // format 1: key wrapped with the server master key
  downloadsLeft: number | null; // null when unlimited
  format?: number; // absent for format 1
  wrappedKey?: string | null; // password mode, base64
  kdfSalt?: string | null; // password mode, base64
}

export function DownloadView({
  slug,
  name,
  size,
  mime,
  expiresAt,
  hasPassword,
  linkMode,
  serverMode,
  downloadsLeft,
  format,
  wrappedKey,
  kdfSalt,
}: DownloadViewProps) {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { setColorScheme } = useMantineColorScheme();
  // Resolve "auto" to the displayed scheme so the first toggle isn't a no-op.
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Encrypted shares reveal the name once the header is decrypted: on mount in
  // link mode, on unlock in password mode.
  const [revealedName, setRevealedName] = useState<string | null>(name);
  // Starts from the stored type and switches to the decrypted one.
  const [revealedMime, setRevealedMime] = useState<string | null>(mime);
  // Small format 2 shares are decrypted on mount; the download button reuses
  // the cached blob, and previewUrl is its blob: URL.
  const [decrypted, setDecrypted] = useState<{
    blob: Blob;
    name: string;
    type: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The service worker URL of the streaming preview for a large format 2 video,
  // set only when the gate in the effect below holds.
  const [swPreviewUrl, setSwPreviewUrl] = useState<string | null>(null);
  // Decoded text of a format 2 text preview, rendered escaped in a <pre>.
  const [previewText, setPreviewText] = useState<string | null>(null);
  // Format 3: the manifest backs the file list, and within the buffer cap the
  // buffered files back per-file saving.
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [buffered, setBuffered] = useState<BufferedFile[] | null>(null);
  // The file being saved, for its spinner, or "all".
  const [savingFile, setSavingFile] = useState<number | "all" | null>(null);
  // The format 3 file previewed from the buffer, or null.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [multiPreviewUrl, setMultiPreviewUrl] = useState<string | null>(null);
  const [multiPreviewText, setMultiPreviewText] = useState<string | null>(null);
  const downloadUrl = `/api/d/${slug}`;

  const exp = describeExpiry(expiresAt);
  const expiryText =
    exp.kind === "never" || exp.kind === "expired"
      ? t(`relexp.${exp.kind}`)
      : t(`relexp.${exp.kind}`, { count: exp.count });

  // The key lives in the URL fragment, which the browser never sends.
  const linkKey =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.hash.slice(1)).get("k") ?? ""
      : "";

  const isV2 = format === 2;
  const isV3 = format === 3;

  const v2Download = async () => {
    if (busy) return;
    if (decrypted) {
      blobDownload(decrypted.blob, decrypted.name);
      return;
    }
    setBusy(true);
    try {
      let secret: DownloadSecret;
      if (linkKey) {
        secret = { keyFromUrl: linkKey };
      } else if (hasPassword && wrappedKey && kdfSalt) {
        const wrapped = Uint8Array.from(
          atob(wrappedKey),
          (c) => c.charCodeAt(0),
        ) as unknown as Uint8Array<ArrayBuffer>;
        const salt = Uint8Array.from(
          atob(kdfSalt),
          (c) => c.charCodeAt(0),
        ) as unknown as Uint8Array<ArrayBuffer>;
        secret = { password, wrapped, salt };
      } else {
        // The link was shared without its fragment and has no password.
        notifications.show({ color: "red", message: t("download.missingKey") });
        return;
      }

      const { meta } = await downloadDecrypted(
        (keyVerifier) =>
          fetch(downloadUrl, {
            headers: { "x-fd-key-verifier": keyVerifier },
          }).then((r) => {
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            return r.body as ReadableStream<Uint8Array>;
          }),
        secret,
        async (plaintext, filename) => {
          if (canStreamDownload()) {
            // size is the ciphertext length, and a Content-Length above the
            // plaintext length makes Chromium fail the download.
            await streamToDownload(plaintext, filename);
          } else {
            const reader = plaintext.getReader();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value as unknown as Uint8Array<ArrayBuffer>);
            }
            blobDownload(new Blob(chunks), filename);
          }
        },
      );
      setRevealedName(meta.name);
      setRevealedMime(meta.type);
    } catch {
      notifications.show({
        color: "red",
        message: hasPassword ? t("download.wrongPassword") : t("download.failed"),
      });
    } finally {
      setBusy(false);
    }
  };

  // A format 3 share is one unit: one counted GET decrypts the blob and unpacks
  // the files. Within the buffer cap every later save reuses that GET, so a
  // limited share is never counted twice. Larger bundles stream the one GET to
  // disk file by file.

  // Notifies and returns null when there is neither a link key nor a password.
  const buildSecret = (): DownloadSecret | null => {
    if (linkKey) return { keyFromUrl: linkKey };
    if (hasPassword && wrappedKey && kdfSalt) {
      const wrapped = Uint8Array.from(
        atob(wrappedKey),
        (c) => c.charCodeAt(0),
      ) as unknown as Uint8Array<ArrayBuffer>;
      const salt = Uint8Array.from(
        atob(kdfSalt),
        (c) => c.charCodeAt(0),
      ) as unknown as Uint8Array<ArrayBuffer>;
      return { password, wrapped, salt };
    }
    notifications.show({ color: "red", message: t("download.missingKey") });
    return null;
  };

  // The key is derived before the fetch, so a wrong password fails without the
  // download being counted. The returned files share one stream and have to be
  // drained in order.
  const fetchMultiDownload = async (
    secret: DownloadSecret,
  ): Promise<MultiDownload> => {
    const key = await deriveContentKey(secret);
    const res = await fetch(downloadUrl, {
      headers: { "x-fd-key-verifier": computeKeyVerifier(key) },
    });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return decryptFilesWithKey(
      streamToAsyncIterable(res.body as ReadableStream<Uint8Array>),
      key,
    );
  };

  // Only for buffered bundles; unbuffered ones stream so a huge file never
  // lands in memory.
  const drainToBlob = async (
    file: { entry: { type: string }; bytes: AsyncGenerator<Uint8Array> },
  ): Promise<Blob> => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for await (const chunk of file.bytes) {
      chunks.push(chunk as unknown as Uint8Array<ArrayBuffer>);
    }
    return new Blob(chunks, { type: file.entry.type });
  };

  // Decrypts a bundle within MULTI_BUFFER_MAX_BYTES once and buffers every file.
  const ensureBuffered = async (): Promise<BufferedFile[] | null> => {
    if (buffered) return buffered;
    const secret = buildSecret();
    if (!secret) return null;
    const dl = await fetchMultiDownload(secret);
    setManifest(dl.manifest);
    const out: BufferedFile[] = [];
    for await (const file of dl.files) {
      const blob = await drainToBlob(file);
      out.push({ name: file.entry.name, type: file.entry.type, blob });
    }
    setBuffered(out);
    return out;
  };

  const saveBuffered = async (f: BufferedFile): Promise<void> => {
    if (canStreamDownload()) {
      await streamToDownload(f.blob.stream(), f.name);
    } else {
      blobDownload(f.blob, f.name);
    }
  };

  // Streams one unbuffered file to disk through the service worker. The files
  // share one decrypted stream and must be drained in order, but the worker
  // reads on its own schedule, so it gets the readable half of a
  // TransformStream while this function pumps the file's bytes into the
  // writable half. Once the pump resolves the next file can advance, and
  // backpressure bounds the bytes in flight. Without a worker the file is
  // collected into a Blob.
  const saveStream = async (
    name: string,
    type: string,
    iter: AsyncIterable<Uint8Array>,
    size: number,
  ): Promise<void> => {
    if (canStreamDownload()) {
      const ts = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>();
      // The manifest size is the exact plaintext length, so Content-Length is
      // safe here.
      await streamToDownload(
        ts.readable as ReadableStream<Uint8Array>,
        name,
        size,
      );
      const writer = ts.writable.getWriter();
      try {
        for await (const chunk of iter) {
          await writer.write(chunk as unknown as Uint8Array<ArrayBuffer>);
        }
        await writer.close();
      } catch (e) {
        await writer.abort(e).catch(() => {});
        throw e;
      }
    } else {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for await (const chunk of iter) {
        chunks.push(chunk as unknown as Uint8Array<ArrayBuffer>);
      }
      blobDownload(new Blob(chunks, { type }), name);
    }
  };

  const multiDownloadAll = async () => {
    if (savingFile !== null) return;
    setSavingFile("all");
    try {
      if (size <= MULTI_BUFFER_MAX_BYTES) {
        const files = await ensureBuffered();
        if (!files) return;
        for (const f of files) await saveBuffered(f);
      } else {
        const secret = buildSecret();
        if (!secret) return;
        const dl = await fetchMultiDownload(secret);
        setManifest(dl.manifest);
        for await (const file of dl.files) {
          await saveStream(
            file.entry.name,
            file.entry.type,
            file.bytes,
            file.entry.size,
          );
        }
      }
    } catch {
      notifications.show({
        color: "red",
        message: hasPassword ? t("download.wrongPassword") : t("download.failed"),
      });
    } finally {
      setSavingFile(null);
    }
  };

  // The per-file buttons only render for buffered bundles, so this never
  // triggers a second counted GET.
  const multiDownloadOne = async (index: number) => {
    if (savingFile !== null || !buffered) return;
    setSavingFile(index);
    try {
      await saveBuffered(buffered[index]);
    } catch {
      notifications.show({
        color: "red",
        message: hasPassword ? t("download.wrongPassword") : t("download.failed"),
      });
    } finally {
      setSavingFile(null);
    }
  };

  const toggleMultiPreview = (index: number) => {
    setPreviewIndex((cur) => (cur === index ? null : index));
  };

  // Writes every file into a picked directory with the File System Access API,
  // which only Chromium offers in a secure context. Large bundles stream each
  // file into its writable.
  const multiSaveToFolder = async () => {
    if (savingFile !== null) return;
    const picker = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker })
      .showDirectoryPicker;
    if (!picker) return;
    let dir: FsDirHandle;
    try {
      dir = await picker();
    } catch {
      // The user cancelled the picker.
      return;
    }
    setSavingFile("all");
    try {
      if (size <= MULTI_BUFFER_MAX_BYTES) {
        const files = await ensureBuffered();
        if (!files) return;
        for (const f of files) {
          const handle = await dir.getFileHandle(f.name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(f.blob);
          await writable.close();
        }
      } else {
        const secret = buildSecret();
        if (!secret) return;
        const dl = await fetchMultiDownload(secret);
        setManifest(dl.manifest);
        for await (const file of dl.files) {
          const handle = await dir.getFileHandle(file.entry.name, {
            create: true,
          });
          const writable = await handle.createWritable();
          for await (const chunk of file.bytes) {
            await writable.write(chunk as unknown as Uint8Array<ArrayBuffer>);
          }
          await writable.close();
        }
      }
    } catch {
      notifications.show({
        color: "red",
        message: hasPassword ? t("download.wrongPassword") : t("download.failed"),
      });
    } finally {
      setSavingFile(null);
    }
  };

  // Unlimited format 3 link shares within the buffer cap load the file list on
  // mount, buffering the files for instant saving. Other shares wait for the
  // user.
  useEffect(() => {
    if (!isV3 || hasPassword || downloadsLeft !== null) return;
    if (size > MULTI_BUFFER_MAX_BYTES || !linkKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const dl = await fetchMultiDownload({ keyFromUrl: linkKey });
        if (cancelled) return;
        setManifest(dl.manifest);
        const out: BufferedFile[] = [];
        for await (const file of dl.files) {
          const blob = await drainToBlob(file);
          out.push({ name: file.entry.name, type: file.entry.type, blob });
        }
        if (!cancelled) setBuffered(out);
      } catch {
        // Leave it collapsed; the action buttons still work.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isV3, hasPassword, downloadsLeft, size, linkKey]);

  // Builds the blob: URL of the selected buffered file and revokes it when the
  // selection changes or the view unmounts.
  useEffect(() => {
    setMultiPreviewText(null);
    if (previewIndex === null || !buffered) {
      setMultiPreviewUrl(null);
      return;
    }
    const file = buffered[previewIndex];
    if (!file || !isPreviewableMime(file.type)) {
      setMultiPreviewUrl(null);
      return;
    }
    // Text needs no object URL; null over the cap shows the "too large" note.
    if (previewKind(file.type) === "text") {
      setMultiPreviewUrl(null);
      let cancelled = false;
      void decodeTextPreview(file.blob).then((text) => {
        if (!cancelled) setMultiPreviewText(text);
      });
      return () => {
        cancelled = true;
      };
    }
    if (file.blob.size > PREVIEW_MAX_BYTES) {
      setMultiPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file.blob);
    setMultiPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [previewIndex, buffered]);

  const [canSaveToFolder, setCanSaveToFolder] = useState(false);
  useEffect(() => {
    setCanSaveToFolder(
      typeof window !== "undefined" &&
        "showDirectoryPicker" in window &&
        window.isSecureContext,
    );
  }, []);

  // Unlimited format 2 link shares under the preview cap are decrypted on mount
  // to reveal the name and render the preview; the download button reuses the
  // cached blob.
  useEffect(() => {
    if (!isV2 || hasPassword || downloadsLeft !== null) return;
    if (size > PREVIEW_MAX_BYTES || !linkKey) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        const { meta } = await downloadDecrypted(
          (keyVerifier) =>
            fetch(downloadUrl, {
              headers: { "x-fd-key-verifier": keyVerifier },
            }).then((r) => {
              if (!r.ok) throw new Error(`fetch ${r.status}`);
              return r.body as ReadableStream<Uint8Array>;
            }),
          { keyFromUrl: linkKey },
          async (plaintext) => {
            const reader = plaintext.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value as unknown as Uint8Array<ArrayBuffer>);
            }
          },
        );
        if (cancelled) return;
        const blob = new Blob(chunks, { type: meta.type });
        setDecrypted({ blob, name: meta.name, type: meta.type });
        setRevealedName(meta.name);
        setRevealedMime(meta.type);
        if (previewKind(meta.type) === "text") {
          const text = await decodeTextPreview(blob);
          if (!cancelled) setPreviewText(text);
        } else if (isPreviewableMime(meta.type)) {
          objectUrl = URL.createObjectURL(blob);
          setPreviewUrl(objectUrl);
        }
      } catch {
        // The download button still works.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isV2, hasPassword, downloadsLeft, size, linkKey, downloadUrl]);

  // A format 2 video over the in-memory cap gets a streaming preview: <video
  // src> points at /sw-preview/<id> and plays without buffering the whole file.
  // It needs a secure context with a service worker, and like the other
  // previews an unlimited, password-less link share, since one playback issues
  // several GETs. Format 3 keeps its buffered preview.
  useEffect(() => {
    if (!isV2 || hasPassword || downloadsLeft !== null) return;
    if (size <= PREVIEW_MAX_BYTES || !linkKey) return;
    if (!canStreamPreview()) return;
    let cancelled = false;
    let handle: PreviewHandle | null = null;
    // Reading the body through an async iterator locks the stream, so
    // res.body.cancel() would throw and the ciphertext would keep downloading.
    // Aborting the fetch tears the body down.
    const abort = new AbortController();
    void (async () => {
      try {
        // Only the header is needed for the metadata. The whole header fits in
        // the first 8 KiB, and ?preview=1 keeps the request uncounted.
        const key = await deriveContentKey({ keyFromUrl: linkKey });
        const res = await fetch(`${downloadUrl}?preview=1`, {
          headers: {
            "x-fd-key-verifier": computeKeyVerifier(key),
            Range: "bytes=0-8191",
          },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`);
        // The same prefix gives the content offset and the decrypted header.
        const prefix = new Uint8Array(await res.arrayBuffer());
        abort.abort();
        const { contentOffset } = peekBlobHeader(prefix);
        async function* fromPrefix(): AsyncGenerator<Uint8Array> {
          yield prefix;
        }
        const { meta } = await decryptWithKey(fromPrefix(), key);
        if (cancelled) return;
        setRevealedName(meta.name);
        setRevealedMime(meta.type);
        if (previewKind(meta.type) !== "video") return;
        // Range math needs the exact plaintext length, which shares uploaded
        // before meta.size existed lack; those get no streaming preview.
        if (typeof meta.size !== "number" || meta.size <= 0) return;
        handle = await registerVideoPreview({
          downloadUrl,
          secret: { keyFromUrl: linkKey },
          mime: meta.type,
          size: meta.size,
          // The size prop is the ciphertext length on disk.
          ciphertextSize: size,
          cf: meta.cf,
          baseNonce: meta.baseNonce ? fromBase64(meta.baseNonce) : undefined,
          contentOffset,
        });
        if (cancelled) {
          handle.release();
          handle = null;
          return;
        }
        setSwPreviewUrl(handle.url);
      } catch {
        // No preview; the download button still works. The AbortError of the
        // teardown lands here too.
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
      if (handle) handle.release();
      setSwPreviewUrl(null);
    };
  }, [isV2, hasPassword, downloadsLeft, size, linkKey, downloadUrl]);

  // Format 1: authorize with a POST, then start the browser's own download.
  const authorizeThenDownload = async (cred: {
    password?: string;
    key?: string;
  }) => {
    setBusy(true);
    try {
      const res = await fetch(downloadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cred),
      });
      if (res.status === 401) {
        // A wrong password or a corrupt link key.
        const message = cred.password
          ? t("download.wrongPassword")
          : t("download.failed");
        notifications.show({ color: "red", message });
        return false;
      }
      if (!res.ok) throw new Error(`verify ${res.status}`);
      const data = (await res.json()) as { name?: string };
      if (data.name) setRevealedName(data.name);
      // The POST response set the download cookie.
      window.location.href = downloadUrl;
      return true;
    } catch (e) {
      notifications.show({
        color: "red",
        message: e instanceof Error ? e.message : t("download.failed"),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Format 1 shares without a password reveal the name on mount with a POST
  // that decrypts only the header: link mode sends the fragment key, server
  // mode an empty credential.
  useEffect(() => {
    if (isV2) return;
    const cred = linkMode && linkKey ? { key: linkKey } : serverMode ? {} : null;
    if (!cred) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(downloadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cred),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          name?: string;
          mime?: string | null;
        };
        if (cancelled) return;
        if (data.name) setRevealedName(data.name);
        if (data.mime) setRevealedMime(data.mime);
      } catch {
        // The download button still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isV2, linkMode, linkKey, serverMode, downloadUrl]);

  const missingKey = linkMode && !linkKey;

  // The key goes along as ?k= because a reverse proxy can delay or strip the
  // fd_key cookie before the image or embed GET. It is already in this page's
  // fragment, so nothing new is exposed.
  const inlineSrc = `${downloadUrl}?inline=1${linkKey ? `&k=${encodeURIComponent(linkKey)}` : ""}`;

  // Previews are only for unlimited, password-less shares, since they would
  // otherwise use up or require a counted download. `||` treats an empty type
  // like a missing one. Older files stored no type, because tus writes an empty
  // file.type as null, so the name's extension fills in.
  const effectiveMime =
    revealedMime || mime || mimeFromName(revealedName ?? name ?? "");
  const v1PreviewKind = previewKind(effectiveMime);
  // Format 1 previews load from the server's ?inline URL, so they use the
  // server allowlist without SVG, and no text, which needs decoded bytes.
  const v1Previewable =
    isServerInlineMime(effectiveMime) && v1PreviewKind !== "text";
  const canPreview =
    v1Previewable &&
    downloadsLeft === null &&
    !hasPassword &&
    !missingKey &&
    revealedName !== null;

  const previewSrc = isV2 ? previewUrl : canPreview ? inlineSrc : null;
  const renderKind = isV2 ? previewKind(effectiveMime) : v1PreviewKind;
  // A null previewText with the text kind means over the cap.
  const isV2TextPreview = isV2 && renderKind === "text";

  return (
    <Container
      size="md"
      py={60}
      style={{
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      {/* Pinned to the viewport corner like on the upload page, whatever the
          Container width. */}
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

      <Center mb={32}>
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
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
        </Link>
      </Center>

      <Paper radius="lg" p="xl" maw={720} mx="auto" w="100%" className="fd-glass">
        <Stack align="center" gap="lg">
          <Stack align="center" gap={2}>
            <Text fw={700} size="xl" ta="center" lineClamp={2}>
              {isV3
                ? manifest
                  ? t("download.fileCount", { count: manifest.files.length })
                  : t("download.multiFile")
                : (revealedName ?? t("download.encryptedFile"))}
            </Text>
            <Text c="dimmed" size="sm">
              {isV3 && manifest
                ? `${t("download.total", {
                    size: formatBytes(
                      manifest.files.reduce((s, f) => s + f.size, 0),
                    ),
                  })} · ${expiryText}`
                : `${formatBytes(size)} · ${expiryText}`}
            </Text>
            {downloadsLeft !== null && (
              <Text c="dimmed" size="xs">
                {t("download.downloadsLeft", { count: downloadsLeft })}
              </Text>
            )}
          </Stack>

          {swPreviewUrl ? (
            <PreviewArea src={swPreviewUrl} kind="video" name={revealedName} />
          ) : isV2TextPreview ? (
            previewText !== null ? (
              <PreviewArea kind="text" text={previewText} name={revealedName} />
            ) : decrypted ? (
              <Text c="dimmed" size="sm" ta="center">
                {t("preview.tooLarge")}
              </Text>
            ) : null
          ) : previewSrc ? (
            <PreviewArea src={previewSrc} kind={renderKind} name={revealedName} />
          ) : null}

          {/* Password shares show the list after a successful unlock. */}
          {isV3 ? (
            <Stack w="100%" gap="md">
              {hasPassword && !buffered && (
                <Stack w="100%" gap="sm">
                  <PasswordInput
                    label={t("download.protected")}
                    placeholder={t("download.passwordPlaceholder")}
                    leftSection={<IconLock size={16} />}
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && void multiDownloadAll()
                    }
                  />
                </Stack>
              )}

              {previewIndex !== null &&
                buffered &&
                buffered[previewIndex] &&
                (() => {
                  const f = buffered[previewIndex];
                  const k = previewKind(f.type);
                  if (k === "text") {
                    return multiPreviewText !== null ? (
                      <PreviewArea
                        kind="text"
                        text={multiPreviewText}
                        name={f.name}
                      />
                    ) : (
                      <Text c="dimmed" size="sm" ta="center">
                        {t("preview.tooLarge")}
                      </Text>
                    );
                  }
                  if (f.blob.size > PREVIEW_MAX_BYTES) {
                    return (
                      <Text c="dimmed" size="sm" ta="center">
                        {t("preview.tooLarge")}
                      </Text>
                    );
                  }
                  return (
                    multiPreviewUrl && (
                      <PreviewArea src={multiPreviewUrl} kind={k} name={f.name} />
                    )
                  );
                })()}

              {manifest && manifest.files.length > 0 && (
                <Stack w="100%" gap={4}>
                  {manifest.files.map((f, i) => {
                    const canPreviewFile =
                      !!buffered && isPreviewableMime(f.type);
                    const isPreviewing = previewIndex === i;
                    return (
                      <Group
                        key={`${f.name}-${i}`}
                        justify="space-between"
                        wrap="nowrap"
                        gap="sm"
                      >
                        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                          <IconFile
                            size={16}
                            style={{ flexShrink: 0, opacity: 0.6 }}
                          />
                          <Box style={{ minWidth: 0 }}>
                            <Text size="sm" truncate>
                              {f.name}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {formatBytes(f.size)}
                            </Text>
                          </Box>
                        </Group>
                        <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                          {canPreviewFile && (
                            <Tooltip
                              label={
                                isPreviewing
                                  ? t("preview.hide")
                                  : t("preview.show")
                              }
                              withArrow
                            >
                              <ActionIcon
                                variant="subtle"
                                aria-label={
                                  isPreviewing
                                    ? t("preview.hide")
                                    : t("preview.show")
                                }
                                onClick={() => toggleMultiPreview(i)}
                              >
                                {isPreviewing ? (
                                  <IconEyeOff size={18} />
                                ) : (
                                  <IconEye size={18} />
                                )}
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {/* Only buffered bundles, so a per-file save never
                              costs a second counted GET. */}
                          {buffered && (
                            <Tooltip label={t("download.download")} withArrow>
                              <ActionIcon
                                variant="subtle"
                                aria-label={t("download.download")}
                                loading={savingFile === i}
                                disabled={
                                  savingFile !== null && savingFile !== i
                                }
                                onClick={() => void multiDownloadOne(i)}
                              >
                                <IconDownload size={18} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </Group>
                    );
                  })}
                  <Divider my={4} />
                </Stack>
              )}

              <Button
                fullWidth
                size="md"
                leftSection={<IconFiles size={18} />}
                loading={savingFile === "all"}
                disabled={savingFile !== null && savingFile !== "all"}
                onClick={() => void multiDownloadAll()}
              >
                {hasPassword && !buffered
                  ? t("download.unlock")
                  : t("download.downloadAll")}
              </Button>

              {canSaveToFolder && (
                <Button
                  fullWidth
                  size="md"
                  variant="default"
                  leftSection={<IconFolder size={18} />}
                  disabled={savingFile !== null}
                  onClick={() => void multiSaveToFolder()}
                >
                  {t("download.saveToFolder")}
                </Button>
              )}
            </Stack>
          ) : isV2 ? (
            /* The branch is on hasPassword, never on the fragment key: the
               server cannot see the fragment, so branching on it would render
               different markup on server and client and trip a hydration
               mismatch. */
            hasPassword ? (
              <Stack w="100%" gap="sm">
                <PasswordInput
                  label={t("download.protected")}
                  placeholder={t("download.passwordPlaceholder")}
                  leftSection={<IconLock size={16} />}
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void v2Download()}
                />
                <Button
                  fullWidth
                  size="md"
                  leftSection={<IconDownload size={18} />}
                  loading={busy}
                  onClick={() => void v2Download()}
                >
                  {t("download.unlock")}
                </Button>
              </Stack>
            ) : (
              <Button
                fullWidth
                size="md"
                leftSection={<IconDownload size={18} />}
                loading={busy}
                onClick={() => void v2Download()}
              >
                {t("download.download")}
              </Button>
            )
          ) : missingKey ? (
            <Text c="red" ta="center" size="sm">
              {t("download.missingKey")}
            </Text>
          ) : hasPassword ? (
            <Stack w="100%" gap="sm">
              <PasswordInput
                label={t("download.protected")}
                placeholder={t("download.passwordPlaceholder")}
                leftSection={<IconLock size={16} />}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && authorizeThenDownload({ password })
                }
              />
              <Button
                fullWidth
                size="md"
                leftSection={<IconDownload size={18} />}
                loading={busy}
                onClick={() => authorizeThenDownload({ password })}
              >
                {t("download.unlock")}
              </Button>
            </Stack>
          ) : (
            <Button
              fullWidth
              size="md"
              leftSection={<IconDownload size={18} />}
              loading={busy}
              onClick={() =>
                authorizeThenDownload(linkMode ? { key: linkKey } : {})
              }
            >
              {t("download.download")}
            </Button>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}

// Renders a preview inertly, so nothing runs scripts against our origin. An
// SVG is only safe inside an <img>, which runs no scripts; it must never go
// through <embed>, <iframe>, <object> or inline markup. Text arrives as the
// `text` prop and renders as escaped React children, never as HTML. A null kind
// renders nothing, so a type outside the allowlist is never embedded. The
// caller owns the object URLs.
function PreviewArea({
  src,
  kind,
  name,
  text,
}: {
  src?: string;
  kind: PreviewKind | null;
  name: string | null;
  text?: string;
}) {
  if (!kind) return null;

  if (kind === "text") {
    return (
      <Box
        w="100%"
        style={{
          borderRadius: "var(--mantine-radius-md)",
          overflow: "hidden",
          background: "var(--mantine-color-default-hover)",
        }}
      >
        <ScrollArea.Autosize mah="min(70vh, 760px)" type="auto">
          <Code
            block
            style={{
              background: "transparent",
              whiteSpace: "pre",
              fontSize: rem(12),
            }}
          >
            {text ?? ""}
          </Code>
        </ScrollArea.Autosize>
      </Box>
    );
  }

  if (!src) return null;
  return (
    <Box
      w="100%"
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: rem(160),
        borderRadius: "var(--mantine-radius-md)",
        overflow: "hidden",
        background: "var(--mantine-color-default-hover)",
      }}
    >
      {kind === "image" ? (
        <img
          src={src}
          alt={name ?? ""}
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: "min(74vh, 820px)",
            objectFit: "contain",
          }}
        />
      ) : kind === "video" ? (
        <video
          src={src}
          controls
          // No autoplay: a preview must not start playing on its own.
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: "min(74vh, 820px)",
          }}
        />
      ) : kind === "audio" ? (
        <audio
          src={src}
          controls
          style={{ display: "block", width: "100%" }}
        />
      ) : (
        <embed
          src={src}
          type="application/pdf"
          style={{
            display: "block",
            width: "100%",
            // A PDF needs a tall frame to be readable.
            height: "min(80vh, 900px)",
            border: "none",
          }}
        />
      )}
    </Box>
  );
}
