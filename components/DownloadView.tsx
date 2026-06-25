"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Paper,
  PasswordInput,
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
import { isPreviewableMime, previewKind, type PreviewKind } from "@/lib/preview";
import { mimeFromName } from "@/lib/mime";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { downloadDecrypted, type DownloadSecret } from "@/lib/e2e/download-flow";
import { decryptFilesWithKey, type MultiDownload } from "@/lib/e2e/multi-pipeline";
import { deriveContentKey } from "@/lib/e2e/pipeline";
import { computeKeyVerifier } from "@/lib/e2e/crypto";
import { streamToAsyncIterable } from "@/lib/e2e/stream-adapters";
import type { Manifest } from "@/lib/e2e/multi-file";
import {
  canStreamDownload,
  streamToDownload,
  blobDownload,
} from "@/lib/e2e/stream-download";

// Inline preview is fully client-side for v2 shares (the server has no ?inline
// route). Below this size we decrypt the whole file into memory once, so we can
// both render a blob: preview and serve the eventual download without a second
// fetch; larger files skip the prefetch and stream straight to disk. (Spec §5.6)
const PREVIEW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// Format-3 (multi-file) bundles up to this combined plaintext size are decrypted
// ONCE and buffered in memory, so the file list, "Download all" and every
// per-file button serve from that single decrypt — exactly ONE counted GET for
// the whole share (download-limit semantics: the share is one unit). Larger
// bundles skip buffering and stream per save (a per-file button re-fetches), so
// memory stays bounded. (Spec "Download flow".)
const MULTI_BUFFER_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

// One buffered file from a format-3 bundle: its name/type and complete bytes.
interface BufferedFile {
  name: string;
  type: string;
  blob: Blob;
}

// File System Access API — not yet in lib.dom; declared minimally for the
// "Save to folder" path. Probed at runtime before use (Chromium + secure ctx).
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
  name: string | null; // null when the server can't see it (encrypted)
  size: number;
  mime: string | null; // content type, used to offer an inline image/PDF preview
  expiresAt: number | null;
  hasPassword: boolean;
  linkMode: boolean; // encrypted, key carried in the URL #fragment
  serverMode: boolean; // encrypted, key wrapped with the server master key
  downloadsLeft: number | null; // remaining downloads, or null when unlimited
  // v2 zero-knowledge props (optional; absent for v1)
  format?: number; // 2 = zero-knowledge; absent/undefined = v1 legacy
  wrappedKey?: string | null; // base64-encoded wrapped content key (password mode)
  kdfSalt?: string | null; // base64-encoded KDF salt (password mode)
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
  // Filename: known from the server for plaintext shares, otherwise revealed
  // after we decrypt the header (link mode on mount, password mode on unlock).
  const [revealedName, setRevealedName] = useState<string | null>(name);
  // Content type used to decide/render the preview. Starts from the DB column and
  // is refined to the authoritative type from the decrypted header once revealed.
  const [revealedMime, setRevealedMime] = useState<string | null>(mime);
  // For small v2 shares we decrypt the whole file once on mount: `decrypted`
  // caches the plaintext blob (reused by the download button — no re-fetch) and
  // `previewUrl` is a blob: URL backing the inline image/PDF preview.
  const [decrypted, setDecrypted] = useState<{
    blob: Blob;
    name: string;
    type: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Format-3 (multi-file) state: the decrypted manifest backs the file list, and
  // (for bundles within the buffer cap) the buffered files back per-file saving.
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [buffered, setBuffered] = useState<BufferedFile[] | null>(null);
  // Index of the file currently being saved (per-file spinner), or "all".
  const [savingFile, setSavingFile] = useState<number | "all" | null>(null);
  // Index of the buffered file currently previewed inline (format 3), or null.
  // The blob: URL is built from the in-memory buffer only — no extra GET.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [multiPreviewUrl, setMultiPreviewUrl] = useState<string | null>(null);
  const downloadUrl = `/api/d/${slug}`;

  const exp = describeExpiry(expiresAt);
  const expiryText =
    exp.kind === "never" || exp.kind === "expired"
      ? t(`relexp.${exp.kind}`)
      : t(`relexp.${exp.kind}`, { count: exp.count });

  // The link key lives only in the URL fragment, never sent to the server in a
  // request line. Read it once on the client.
  const linkKey =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.hash.slice(1)).get("k") ?? ""
      : "";

  // -------------------------------------------------------------------------
  // v2 zero-knowledge download handler
  // The server streams back the raw ciphertext; the browser decrypts in-place.
  // -------------------------------------------------------------------------
  const isV2 = format === 2;
  // format 3 = zero-knowledge MULTI-file (manifest unpacked client-side).
  const isV3 = format === 3;

  const v2Download = async () => {
    if (busy) return;
    // Small share already decrypted on mount for the preview — just save the
    // cached blob, no second fetch/decrypt.
    if (decrypted) {
      blobDownload(decrypted.blob, decrypted.name);
      return;
    }
    setBusy(true);
    try {
      // Determine the decryption secret.
      // Link mode: key from the URL fragment (#k=<key>).
      // Password mode: password + wrapped key material from the server props.
      let secret: DownloadSecret;
      if (linkKey) {
        secret = { keyFromUrl: linkKey };
      } else if (hasPassword && wrappedKey && kdfSalt) {
        // Decode base64 → Uint8Array<ArrayBuffer>.
        // Cast required for TS 5.9 strict Uint8Array<ArrayBuffer> variance.
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
        // No key in URL and no password material — link was shared without the
        // fragment and has no password; can't decrypt.
        notifications.show({ color: "red", message: t("download.missingKey") });
        return;
      }

      const { meta } = await downloadDecrypted(
        // The flow derives the content key first (a wrong password rejects
        // before any fetch) and hands us its SHA-256 verifier: the server
        // requires this proof of key knowledge before counting the download.
        (keyVerifier) =>
          fetch(downloadUrl, {
            headers: { "x-fd-key-verifier": keyVerifier },
          }).then((r) => {
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            // r.body is ReadableStream<Uint8Array> at runtime.
            return r.body as ReadableStream<Uint8Array>;
          }),
        secret,
        async (plaintext, filename) => {
          if (canStreamDownload()) {
            // No size: `size` is the CIPHERTEXT length (DB column) and the
            // decrypted metadata carries only {name, type} — a Content-Length
            // larger than the plaintext makes Chromium mark the download as
            // failed, so the SW must not set one.
            await streamToDownload(plaintext, filename);
          } else {
            // Blob fallback: collect the stream into memory.
            // Cast to Uint8Array<ArrayBuffer> so TS 5.9 strict variance accepts
            // the chunks as BlobPart[] (SharedArrayBuffer variant is excluded).
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
      // Reveal the real filename after a successful decrypt.
      setRevealedName(meta.name);
      setRevealedMime(meta.type);
    } catch {
      // downloadDecrypted rejects on a wrong key/password.
      notifications.show({
        color: "red",
        message: hasPassword ? t("download.wrongPassword") : t("download.failed"),
      });
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // format-3 (multi-file) download handlers
  //
  // The share is ONE unit: a single counted GET decrypts the whole opaque blob
  // and unpacks the manifest into the original files. For bundles within the
  // buffer cap we decrypt once into memory (buffered) so the list, "Download
  // all" and every per-file button reuse that single GET — never double-counting
  // a limited share, mirroring how format 2 caches its decrypted blob. Larger
  // bundles skip buffering: "Download all" streams the one GET to disk file by
  // file, and a per-file button re-fetches + re-decrypts and skips to that file
  // (acceptable — keeps memory bounded).
  // -------------------------------------------------------------------------

  // Build the format-3 decryption secret from the link key or password material.
  // Returns null (and notifies) when neither is available.
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

  // Fetch + decrypt the one blob with the key-verifier header — exactly like the
  // format-2 download (one counted-eligible GET). The content key is derived
  // first (a wrong password rejects BEFORE any fetch, so nothing is counted),
  // then base64url(SHA-256(K)) is sent as the proof the server requires before
  // counting/burning. Returns the MultiDownload whose per-file `bytes` generators
  // share one stream and MUST be drained IN ORDER.
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

  // Drain one per-file generator fully into a single Blob (preserves order).
  // ONLY used for the buffered (<= MULTI_BUFFER_MAX_BYTES) path; the unbuffered
  // path streams each file instead so a single huge file never lands in RAM.
  const drainToBlob = async (
    file: { entry: { type: string }; bytes: AsyncGenerator<Uint8Array> },
  ): Promise<Blob> => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for await (const chunk of file.bytes) {
      chunks.push(chunk as unknown as Uint8Array<ArrayBuffer>);
    }
    return new Blob(chunks, { type: file.entry.type });
  };

  // Decrypt the bundle once and buffer every file in memory (manifest order).
  // Used ONLY for bundles within MULTI_BUFFER_MAX_BYTES: a single counted GET
  // serves all later saves (and per-file buttons). Sets `manifest` + `buffered`.
  const ensureBuffered = async (): Promise<BufferedFile[] | null> => {
    if (buffered) return buffered;
    const secret = buildSecret();
    if (!secret) return null;
    const dl = await fetchMultiDownload(secret);
    setManifest(dl.manifest);
    const out: BufferedFile[] = [];
    // Drain each file fully before the next — the generators share one stream.
    for await (const file of dl.files) {
      const blob = await drainToBlob(file);
      out.push({ name: file.entry.name, type: file.entry.type, blob });
    }
    setBuffered(out);
    return out;
  };

  // Save one buffered file via the SW stream where available, else a blob anchor.
  const saveBuffered = async (f: BufferedFile): Promise<void> => {
    if (canStreamDownload()) {
      await streamToDownload(f.blob.stream(), f.name);
    } else {
      blobDownload(f.blob, f.name);
    }
  };

  // Stream one UNBUFFERED file's bytes straight to disk via the SW download —
  // no whole-file Blob, so a single huge file can't OOM the tab.
  //
  // The per-file generators share ONE underlying decrypted stream and must be
  // drained strictly in order, but the SW reads its transferred stream on its
  // own schedule. So we DON'T hand the SW a live generator-backed stream (it
  // would interleave reads across files and corrupt the split). Instead we pass
  // the SW the readable half of a TransformStream and pump THIS file's bytes
  // into the writable half ourselves, awaiting completion: when the pump
  // resolves, this file's slice of the source has been fully consumed, so the
  // next file's generator can safely advance. The writer's backpressure keeps
  // the in-flight bytes bounded (no whole-file buffer). When the SW is
  // unavailable we fall back to collecting into a Blob — the same inherent
  // limitation as the single-file format-2 fallback.
  const saveStream = async (
    name: string,
    type: string,
    iter: AsyncIterable<Uint8Array>,
    size: number,
  ): Promise<void> => {
    if (canStreamDownload()) {
      const ts = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>();
      // Hand the readable side to the SW (it sets up the save dialog and starts
      // reading); the exact plaintext size lets it send a correct Content-Length.
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

  // "Download all": save every file in manifest order (sequential). Buffers the
  // bundle once for small shares (later saves reuse it); streams the single GET
  // file-by-file for large ones, materializing no whole file in RAM.
  const multiDownloadAll = async () => {
    if (savingFile !== null) return;
    setSavingFile("all");
    try {
      if (size <= MULTI_BUFFER_MAX_BYTES) {
        const files = await ensureBuffered();
        if (!files) return;
        for (const f of files) await saveBuffered(f);
      } else {
        // Large bundle: one counted GET, stream each file to disk in order.
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

  // Per-file "Download": ONLY for buffered bundles — serves the file from the
  // in-memory buffer, so it never triggers a second counted GET. The per-file
  // buttons are rendered only when `buffered` is set (see the file list below),
  // so large/unbuffered bundles never reach this and can't double-count.
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

  // Per-file inline "Preview" toggle (format 3): show/hide the previewed file.
  // Previews ONLY from the in-memory buffer (zero extra counted GETs); the
  // blob: URL is (re)built by the effect below when `previewIndex` changes.
  const toggleMultiPreview = (index: number) => {
    setPreviewIndex((cur) => (cur === index ? null : index));
  };

  // "Save to folder" (Chromium + secure context only): pick a directory and write
  // every file into it via the File System Access API. Small bundles write from
  // the in-memory buffer; large bundles stream each file's bytes straight into
  // the writable chunk by chunk, so no whole file is materialized in RAM.
  const multiSaveToFolder = async () => {
    if (savingFile !== null) return;
    const picker = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker })
      .showDirectoryPicker;
    if (!picker) return;
    let dir: FsDirHandle;
    try {
      dir = await picker();
    } catch {
      // User cancelled the picker — not an error.
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
          // Stream the file's chunks into the writable — bounded memory.
          // Cast to Uint8Array<ArrayBuffer> for TS 5.9 strict BufferSource
          // variance (the SharedArrayBuffer variant is excluded at runtime).
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

  // Reveal the manifest (file list) on mount for password-less, in-cap format-3
  // link shares — one counted GET that also buffers the files for instant saving,
  // mirroring the format-2 preview prefetch. Password / over-cap shares stay
  // collapsed until the user acts.
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

  // Format-3 inline preview: (re)build a blob: URL for the selected buffered file
  // and revoke it whenever the selection changes or the component unmounts, so a
  // previewed video/image never leaks an object URL. Built ONLY from the in-memory
  // buffer (no fetch), so previewing never costs a counted GET.
  useEffect(() => {
    if (previewIndex === null || !buffered) {
      setMultiPreviewUrl(null);
      return;
    }
    const file = buffered[previewIndex];
    // Skip building the object URL for non-previewable types and for files over
    // the cap (the render shows a "too large" note instead) — no wasted URL.
    if (!file || !isPreviewableMime(file.type) || file.blob.size > PREVIEW_MAX_BYTES) {
      setMultiPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file.blob);
    setMultiPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [previewIndex, buffered]);

  // Whether the "Save to folder" button can be offered (Chromium + secure ctx).
  const [canSaveToFolder, setCanSaveToFolder] = useState(false);
  useEffect(() => {
    setCanSaveToFolder(
      typeof window !== "undefined" &&
        "showDirectoryPicker" in window &&
        window.isSecureContext,
    );
  }, []);

  // Auto-decrypt small v2 link shares on mount: reveals the real filename and
  // renders an inline image/PDF preview — all client-side (the server never sees
  // the key or the plaintext). Gated to unlimited, password-less link shares
  // under the size cap; the decrypted blob is cached so the download button
  // reuses it without a second fetch. (Spec §5.6.) Runs in an effect, so reading
  // the #fragment key here can't cause a hydration mismatch.
  useEffect(() => {
    if (!isV2 || hasPassword || downloadsLeft !== null) return;
    if (size > PREVIEW_MAX_BYTES || !linkKey) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        const { meta } = await downloadDecrypted(
          // Same key-verifier header as the download button — the prefetch is a
          // real, counted-eligible GET and must carry the same proof.
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
        if (isPreviewableMime(meta.type)) {
          objectUrl = URL.createObjectURL(blob);
          setPreviewUrl(objectUrl);
        }
      } catch {
        // Leave the share undecrypted; the download button still works.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isV2, hasPassword, downloadsLeft, size, linkKey, downloadUrl]);

  // -------------------------------------------------------------------------
  // v1 helpers (unchanged)
  // -------------------------------------------------------------------------

  // Authorize the download (POST), then trigger the native streaming GET.
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
        // 401 means a wrong credential: a bad password, or a corrupt link key.
        const message = cred.password
          ? t("download.wrongPassword")
          : t("download.failed");
        notifications.show({ color: "red", message });
        return false;
      }
      if (!res.ok) throw new Error(`verify ${res.status}`);
      const data = (await res.json()) as { name?: string };
      if (data.name) setRevealedName(data.name);
      // Cookie is set; trigger the native streaming download.
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

  // Reveal the real filename on mount for shares that need no password: link
  // mode (decrypt with the #fragment key) and server mode (the server decrypts
  // with its master key, so an empty credential is enough). A POST that decrypts
  // just the header, without downloading yet.
  useEffect(() => {
    // v2 shares reveal the name after decryption — skip this v1-only effect.
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
        // Leave the name hidden; the download button still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isV2, linkMode, linkKey, serverMode, downloadUrl]);

  const missingKey = linkMode && !linkKey;

  // Inline preview URL: pass the link key as ?k= so the server can decrypt
  // without relying on the fd_key cookie reaching the image/embed GET (which can
  // fail when a reverse proxy delays or strips Set-Cookie delivery). The key is
  // already in the URL fragment on this page, so no new information is exposed.
  const inlineSrc = `${downloadUrl}?inline=1${linkKey ? `&k=${encodeURIComponent(linkKey)}` : ""}`;

  // Inline preview for images/PDFs — only for unlimited, password-less shares
  // (a preview would otherwise consume or require a counted download). The
  // preview GET (?inline=1) never counts and is refused for limited shares.
  // Prefer the type revealed from the decrypted header over the DB column.
  // Use `||` (not `??`) so both null AND empty-string are treated as missing.
  // Fall back to inferring from the revealed filename: old files stored mime=null
  // (tus encodes empty file.type as null in the sidecar) and the DB column was
  // written before the filename-extension fallback was added to finalize.
  const effectiveMime =
    revealedMime || mime || mimeFromName(revealedName ?? name ?? "");
  const previewable = isPreviewableMime(effectiveMime);
  const canPreview =
    previewable &&
    downloadsLeft === null &&
    !hasPassword &&
    !missingKey &&
    revealedName !== null;

  // v1 previews via the server's ?inline endpoint, which only serves an inline
  // response for the inert allowlist (with nosniff). The render kind comes from
  // the same effectiveMime the gate checked; previewKind maps image/video/PDF
  // uniformly — including a v1 share whose decrypted header MIME is video/*.
  const v1PreviewKind = previewKind(effectiveMime);

  // v1 previews via the server's ?inline endpoint; v2 has no server inline route
  // and previews from the in-memory blob: URL decrypted on mount above.
  const previewSrc = isV2 ? previewUrl : canPreview ? inlineSrc : null;

  return (
    <Container size="sm" py={60} style={{ position: "relative", minHeight: "100vh" }}>
      {/* Pinned to the viewport top-right — same spot as the upload page,
          independent of this page's narrower Container width. */}
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

      {/* Brand at the top, centered, linking home — same as the main page. */}
      <Center mb={88}>
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

      <Paper radius="lg" p="xl" maw={460} mx="auto" w="100%" className="fd-glass">
        <Stack align="center" gap="lg">
          {/* Logo only (no wordmark) crowning the card, like the drop zone. */}
          <Logo size={48} />

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

          {previewSrc && (
            <PreviewArea
              src={previewSrc}
              kind={isV2 ? previewKind(effectiveMime) : v1PreviewKind}
              name={revealedName}
            />
          )}

          {/* -----------------------------------------------------------
              format-3 zero-knowledge MULTI-file download UI
              Renders the manifest as a file list (name + size) with a per-file
              Download button, a per-file inline Preview toggle (previewable,
              buffered files only — rendered from the in-memory buffer, no extra
              GET), a "Download all" (sequential, original names) and — only on
              Chromium + a secure context — a "Save to folder" button. Password
              shares show the password input first; the list appears after a
              successful unlock.
              ----------------------------------------------------------- */}
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

              {/* Inline preview of the selected buffered file, rendered above the
                  list. Built ONLY from the in-memory buffer (no extra GET). Files
                  over the per-file preview cap show a "too large" note instead. */}
              {previewIndex !== null &&
                buffered &&
                buffered[previewIndex] &&
                (buffered[previewIndex].blob.size > PREVIEW_MAX_BYTES ? (
                  <Text c="dimmed" size="sm" ta="center">
                    {t("preview.tooLarge")}
                  </Text>
                ) : (
                  multiPreviewUrl && (
                    <PreviewArea
                      src={multiPreviewUrl}
                      kind={previewKind(buffered[previewIndex].type)}
                      name={buffered[previewIndex].name}
                    />
                  )
                ))}

              {manifest && manifest.files.length > 0 && (
                <Stack w="100%" gap={4}>
                  {manifest.files.map((f, i) => {
                    // Preview is offered only for buffered, previewable files —
                    // the toggle renders from the in-memory buffer (no extra GET).
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
                          {/* Per-file Preview toggle: only for buffered,
                              previewable files. It shows the inline preview from
                              the in-memory buffer — never a counted GET. */}
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
                          {/* Per-file Download is offered ONLY for buffered
                              bundles (<= MULTI_BUFFER_MAX_BYTES): it serves the
                              file from the in-memory buffer, so it never triggers
                              a second counted GET. For large/unbuffered bundles the
                              list is read-only; "Download all" / "Save to folder"
                              do the single GET. */}
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
          ) : /* -----------------------------------------------------------
              v2 zero-knowledge download UI
              Password mode: password input + Unlock button.
              Link mode:     a single Download button (key is in the fragment).
              The branch depends ONLY on hasPassword (a server-known prop), never
              on the URL #fragment key — the fragment is invisible to the server,
              so branching on it would render different markup on the server vs.
              the client and trip a hydration mismatch (React #418/#423). A link
              that was copied without its #k= fragment is caught at click time by
              v2Download, which shows the missing-key notification.
              ----------------------------------------------------------- */
          isV2 ? (
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
          ) : /* -----------------------------------------------------------
              v1 legacy download UI (unchanged)
              ----------------------------------------------------------- */
          missingKey ? (
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

// Inline preview frame shared by the format-2 single-file preview and the
// format-3 per-file preview. Renders from an already-prepared blob:/inline URL —
// it never fetches or decrypts. `kind` decides the element: an inert <img> for
// images, <video controls> (no autoplay) for video, <embed> for PDF. Anything
// else (kind === null) renders nothing, so a non-allowlisted type can never be
// embedded. Object-URL lifecycle is owned by the caller (created/revoked in an
// effect), so this component stays purely presentational.
function PreviewArea({
  src,
  kind,
  name,
}: {
  src: string;
  kind: PreviewKind | null;
  name: string | null;
}) {
  if (!kind) return null;
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
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name ?? ""}
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: 360,
            objectFit: "contain",
          }}
        />
      ) : kind === "video" ? (
        <video
          src={src}
          controls
          // No autoplay: previewing must not start playback or sound on its own.
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: 360,
          }}
        />
      ) : (
        <embed
          src={src}
          type="application/pdf"
          style={{
            display: "block",
            width: "100%",
            height: 360,
            border: "none",
          }}
        />
      )}
    </Box>
  );
}
