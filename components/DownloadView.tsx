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

// Inline preview is fully client-side for v2 shares (the server has no ?inline
// route). Below this size we decrypt the whole file into memory once, so we can
// both render a blob: preview and serve the eventual download without a second
// fetch; larger files skip the prefetch and stream straight to disk. (Spec §5.6)
const PREVIEW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// Text/code previews get a SEPARATE, much smaller cap: a giant log decoded into
// a single <pre> would freeze the tab, so over this size we show the same
// "too large" note as other kinds and offer the download instead. (The bytes are
// already in memory either way — this only bounds how much we DECODE + render.)
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

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

// Decode an already-in-memory blob to UTF-8 text for a text/code preview, but
// only up to TEXT_PREVIEW_MAX_BYTES so a huge log can't freeze the tab. Returns
// null when the blob is over the cap (the caller shows the "too large" note).
// Reads from the in-memory blob only — never a fetch, so it costs no counted GET.
async function decodeTextPreview(blob: Blob): Promise<string | null> {
  if (blob.size > TEXT_PREVIEW_MAX_BYTES) return null;
  const buf = await blob.arrayBuffer();
  // "fatal: false" so undecodable bytes become U+FFFD instead of throwing — a
  // mislabeled binary still renders as (garbled) text rather than breaking.
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
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
  // Streaming inline preview for a LARGE (over the in-memory blob cap) format-2
  // video: a /sw-preview/<id> URL served by the download service worker. Set only
  // when the feature-detect + count-safety gate below holds; otherwise null and
  // the over-cap share keeps today's behavior (no preview, just the download
  // button). Memory stays bounded — the video is never collected into a blob.
  const [swPreviewUrl, setSwPreviewUrl] = useState<string | null>(null);
  // Decoded text for the format-2 text/code preview (UTF-8, capped). Rendered as
  // ESCAPED React children in a <pre> — never as HTML. null = not a text preview.
  const [previewText, setPreviewText] = useState<string | null>(null);
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
  // Decoded text for the format-3 per-file text/code preview (UTF-8, capped),
  // mirroring previewText. Rendered ESCAPED in a <pre>, never as HTML.
  const [multiPreviewText, setMultiPreviewText] = useState<string | null>(null);
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
    // Text/code: decode the in-memory bytes (capped) and render them ESCAPED in a
    // <pre> — no object URL. decodeTextPreview returns null over the text cap, so
    // the render falls through to the "too large" note. Reuses the buffer (no GET).
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
    // Other kinds: build a blob: URL. Skip files over the cap (the render shows a
    // "too large" note instead) — no wasted URL.
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
        // Text/code previews from the decoded bytes (capped); every other
        // previewable kind renders from a blob: URL. Both reuse the in-memory
        // blob only — no second, counted fetch.
        if (previewKind(meta.type) === "text") {
          const text = await decodeTextPreview(blob);
          if (!cancelled) setPreviewText(text); // null over the cap → "too large"
        } else if (isPreviewableMime(meta.type)) {
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

  // STREAMING inline preview for a LARGE format-2 video — the only case the
  // blob-preview effect above deliberately skips (size > PREVIEW_MAX_BYTES). When
  // the service worker can serve it we point <video src> at /sw-preview/<id> and
  // play progressively without ever buffering the whole video into memory.
  //
  // Feature-detect (all must hold; otherwise this effect no-ops and the over-cap
  // share keeps today's behavior — no preview, just the download button):
  //   - secure context AND an available/active service worker (canStreamPreview),
  //   - format 2 single-file (isV2) — multi-file (format 3) keeps the buffered-
  //     blob preview and is intentionally NOT streamed here,
  //   - the file is OVER the in-memory blob cap (size > PREVIEW_MAX_BYTES); at or
  //     under the cap the blob-preview effect above handles it,
  //   - the decrypted MIME's preview kind is "video".
  //
  // Count-safety: a streaming preview is a GET of the share (and a single
  // playback can issue several — one per Range/seek), so it is gated to UNLIMITED
  // shares (downloadsLeft === null) exactly like the existing previews. On an
  // unlimited share registerDownload() only bumps a cosmetic counter and never
  // burns/limits, so it can never consume a download-limited or burn-after share.
  // Also requires a password-less LINK share (the #fragment key) so the key is
  // available without an unlock step — mirroring the blob-preview gate.
  useEffect(() => {
    if (!isV2 || hasPassword || downloadsLeft !== null) return;
    if (size <= PREVIEW_MAX_BYTES || !linkKey) return;
    if (!canStreamPreview()) return;
    let cancelled = false;
    let handle: PreviewHandle | null = null;
    // AbortController, not stream.cancel(): decryptWithKey's blob-meta read takes
    // over the response body via its async iterator, which LOCKS the stream — so a
    // later res.body.cancel() throws "locked" (silently caught) and the full
    // ciphertext keeps downloading in the background. Aborting the fetch tears the
    // body down cleanly once we have the header.
    const abort = new AbortController();
    void (async () => {
      try {
        // Header-only decrypt to learn the metadata WITHOUT decrypting the whole
        // video: decryptWithKey reads just the blob-meta header to produce `meta`;
        // its returned plaintext generator is never pulled, so no body bytes are
        // decrypted. We abort right after, so this is a tiny ranged-prefix read.
        // Same key-verifier proof the server requires; ?preview=1 makes it a
        // NO-COUNT GET on unlimited shares (the server enforces unlimited-only).
        const key = await deriveContentKey({ keyFromUrl: linkKey });
        // Range the header read to the first 8 KiB: [varint][enc_meta] all live
        // there, so this never pulls the whole ciphertext even before the abort.
        // (Server replies 206 with just the prefix.)
        const res = await fetch(`${downloadUrl}?preview=1`, {
          headers: {
            "x-fd-key-verifier": computeKeyVerifier(key),
            Range: "bytes=0-8191",
          },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`);
        // Buffer the prefix bytes so we can BOTH compute the content offset
        // (where the encrypted chunks begin, after [varint(metaLen)][enc_meta])
        // and decrypt the header from the SAME bytes — no second fetch. The 8 KiB
        // prefix comfortably holds the whole [varint][enc_meta] header.
        const prefix = new Uint8Array(await res.arrayBuffer());
        // Tear down the response body so the rest of the ciphertext is NOT
        // fetched in the background.
        abort.abort();
        // contentOffset = absolute blob offset of the first encrypted chunk; the
        // cf=2 seek factory adds it to a chunk's content-relative cipher range.
        const { contentOffset } = peekBlobHeader(prefix);
        async function* fromPrefix(): AsyncGenerator<Uint8Array> {
          yield prefix;
        }
        const { meta } = await decryptWithKey(fromPrefix(), key);
        if (cancelled) return;
        setRevealedName(meta.name);
        setRevealedMime(meta.type);
        // Only stream-preview videos; other large kinds keep the download-only UI.
        if (previewKind(meta.type) !== "video") return;
        // Exact PLAINTEXT length is REQUIRED for correct Range math. It lives in
        // the encrypted meta (meta.size). Shares uploaded before that field
        // existed omit it — for those, fall back to today's behavior (no
        // streaming preview) rather than do Range math against the wrong size.
        if (typeof meta.size !== "number" || meta.size <= 0) return;
        handle = await registerVideoPreview({
          downloadUrl,
          secret: { keyFromUrl: linkKey },
          mime: meta.type,
          // meta.size = exact PLAINTEXT length (Range math); the `size` prop is
          // rec.size = the on-disk CIPHERTEXT length (bounds the cf=1 prefix fetch).
          size: meta.size,
          ciphertextSize: size,
          // cf=2 → TRUE seeking: the factory fetches only the covering chunks,
          // mapping plaintext offsets to absolute blob bytes via contentOffset +
          // baseNonce. cf=1/absent → the legacy from-0 secretstream factory.
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
        // Leave the share without a streaming preview; the download button works.
        // (An AbortError from our own teardown lands here too — harmless.)
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
      if (handle) handle.release();
      setSwPreviewUrl(null);
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
  const v1PreviewKind = previewKind(effectiveMime);
  // v1 previews load the file's bytes from a URL (the server's ?inline route), so
  // they're limited to what that URL flow supports:
  //   - the STRICT server-inline allowlist (isServerInlineMime), which excludes
  //     image/svg+xml — SVG must never be served inline by the server (top-level
  //     document = scriptable). SVG is previewable only as a CLIENT blob: <img>,
  //     i.e. format 2/3, never here.
  //   - NOT the "text" kind: a text preview needs decoded text children, which
  //     the URL flow can't provide (PreviewArea gets a src URL, not bytes). Text
  //     previews are client-blob only (format 2/3).
  const v1Previewable =
    isServerInlineMime(effectiveMime) && v1PreviewKind !== "text";
  const canPreview =
    v1Previewable &&
    downloadsLeft === null &&
    !hasPassword &&
    !missingKey &&
    revealedName !== null;

  // v1 previews via the server's ?inline endpoint; v2 has no server inline route
  // and previews from the in-memory blob: URL decoded on mount above.
  const previewSrc = isV2 ? previewUrl : canPreview ? inlineSrc : null;
  // For v2 the render kind comes from the decrypted header MIME; for v1 from the
  // same effectiveMime the server-inline gate checked.
  const renderKind = isV2 ? previewKind(effectiveMime) : v1PreviewKind;
  // v2 text/code preview: show the decoded text (or a "too large" note if it was
  // over the text cap, signalled by a null previewText while the kind is "text").
  const isV2TextPreview = isV2 && renderKind === "text";

  return (
    <Container size="md" py={60} style={{ position: "relative", minHeight: "100vh" }}>
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

          {/* STREAMING preview of a LARGE format-2 video: the SW-served
              /sw-preview/<id> URL feeds a <video> that plays progressively
              without buffering the whole file. Set only when the feature-detect +
              count-safety gate held (see the effect above); takes precedence over
              the blob preview, which never runs for an over-cap file. Seeking is
              fast within the played/buffered region; a far-forward seek
              re-decrypts from the start (slow but correct). */}
          {swPreviewUrl ? (
            <PreviewArea src={swPreviewUrl} kind="video" name={revealedName} />
          ) : /* format-2 / v1 single-file inline preview. Text/code (format 2
              only) renders the decoded text; a text file over the text cap shows
              the "too large" note instead. Every other kind renders from the URL. */
          isV2TextPreview ? (
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
                  list. Built ONLY from the in-memory buffer (no extra GET). Text/
                  code renders the decoded text (text cap); every other kind from a
                  blob: URL (media cap). Over either cap → a "too large" note. */}
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
// format-3 per-file preview. Purely presentational — it never fetches or
// decrypts. `kind` decides the element, and every element renders the content
// INERTLY (no script execution against our origin):
//   - image: an <img> with the blob:/inline URL. This is ALSO the ONLY safe way
//            to render image/svg+xml — an SVG inside an <img> runs no scripts
//            ("secure static mode"). SVG must NEVER be rendered via
//            <embed>/<iframe>/<object> or inlined into the DOM, and the server
//            must never serve it inline (see isServerInlineMime). Do not change
//            the SVG path away from <img>.
//   - video: <video controls> (no autoplay) from the blob:/inline URL.
//   - audio: <audio controls> (no autoplay) from the blob:/inline URL.
//   - pdf:   <embed type="application/pdf"> from the blob:/inline URL.
//   - text:  the decoded `text` prop rendered as ESCAPED React children inside a
//            Mantine <Code> in a scrollable monospace block. NEVER via
//            dangerouslySetInnerHTML/innerHTML, and Markdown is shown as raw text
//            (no HTML rendering). For this kind the caller passes `text`, not `src`.
// kind === null renders nothing, so a non-allowlisted type can never be embedded.
// Object-URL lifecycle (for the URL-backed kinds) is owned by the caller.
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

  // Text/code: a scrollable monospace block. The decoded string is passed as a
  // React child of <Code>, so React escapes it — no HTML is ever interpreted.
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
        // <img> renders raster images AND svg safely (svg = no scripts here).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name ?? ""}
          style={{
            display: "block",
            maxWidth: "100%",
            // Large + responsive: fill most of the viewport height on big
            // screens, capped so it never overflows on very tall windows.
            maxHeight: "min(74vh, 820px)",
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
            maxHeight: "min(74vh, 820px)",
          }}
        />
      ) : kind === "audio" ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          src={src}
          controls
          // No autoplay: previewing must not start playback or sound on its own.
          style={{ display: "block", width: "100%" }}
        />
      ) : (
        <embed
          src={src}
          type="application/pdf"
          style={{
            display: "block",
            width: "100%",
            // A PDF needs a tall frame to be readable — match the media cap.
            height: "min(80vh, 900px)",
            border: "none",
          }}
        />
      )}
    </Box>
  );
}
