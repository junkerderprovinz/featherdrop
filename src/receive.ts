// The share behind /d/<slug>, for whoever got the link. A format 4 link lists
// its files from the uncounted header, asks for the password of a
// link-and-password share, saves one file alone from an unlimited share or the
// whole share, a bundle as one ZIP, and reads a note. Links of the older
// formats 2 and 3 still open, list and download.
import { reactive } from "vue";
import { fromBase64 } from "@/lib/e2e/base64";
import { downloadDecrypted, downloadDecryptedV2, downloadFileV2, DownloadInProgressError, fetchShareBlob, type DownloadSecret } from "@/lib/e2e/download-flow";
import { HttpError } from "@/lib/e2e/http-error";
import { splitByManifest } from "@/lib/e2e/multi-file";
import { readNote } from "@/lib/e2e/note";
import { fetchShareHeader, fetchShareListing, openLink } from "@/lib/e2e/share-listing";
import { streamToAsyncIterable, watchConsumed } from "@/lib/e2e/stream-adapters";
import { blobDownload, canStreamDownload, streamToDownload } from "@/lib/e2e/stream-download";
import { canStreamPreview, registerVideoPreview, type PreviewHandle } from "@/lib/e2e/stream-preview";
import { zipLength, zipStream, type ZipEntry } from "@/lib/e2e/zip";
import { cryptoWorker } from "@/lib/e2e/v2/crypto-worker";
import type { Kind } from "@/lib/e2e/v2/layout";
import type { LegacyKey } from "@/lib/e2e/v2/protocol";
import { decryptBundleInWorker, decryptInWorker } from "@/lib/e2e/v2/remote";
import { decodeToken, isV2Link, type ShareKeys } from "@/lib/e2e/v2/token";
import { mimeFromName } from "@/lib/mime";
import { previewKind, type PreviewKind } from "@/lib/preview";
import { wait } from "@/src/format";
import { t } from "@/src/i18n";

// Up to this size a preview is decrypted into memory; text has a smaller cap,
// since a huge log in one <pre> would freeze the tab.
export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
// Images up to this size show as their own thumbnail in the list.
const THUMB_MAX_BYTES = 2 * 1024 * 1024;
// A format 3 bundle up to this size is decrypted once and kept, so a single
// file or a preview never costs a second counted download.
const LEGACY_BUFFER_MAX_BYTES = 100 * 1024 * 1024;

// The body of server-go/internal/api/meta.go.
interface ShareMeta {
  format: number;
  size: number;
  expiresAt: number | null;
  hasPassword: boolean;
  downloadsLeft: number | null;
  wrappedKey: string | null;
  kdfSalt: string | null;
}

export type Gone = "expired" | "burned" | "missing" | "nokey";

export interface Entry {
  index: number;
  name: string;
  type: string;
  /** Plaintext size, or null for an old single-file share that never stored it. */
  size: number | null;
  done: number;
}

export interface Preview {
  kind: PreviewKind;
  url?: string;
  text?: string;
}

/** Where the keys come from: a format 4 link, or the older formats' key or password. */
type Opened = { format: 4; keys: ShareKeys } | { format: 2 | 3; key: LegacyKey; secret: DownloadSecret };

export const share = reactive({
  view: "loading" as "loading" | "locked" | "ready" | "downloading" | "note" | "gone",
  gone: "missing" as Gone,
  slug: "",
  size: 0,
  expiresAt: null as number | null,
  downloadsLeft: null as number | null,
  /** Null while the names are not known yet. */
  items: null as Entry[] | null,
  kind: "single" as Kind,
  phase: "decrypting" as "decrypting" | "saving",
  progress: 0,
  only: null as number | null,
  note: "",
  error: "",
  busy: false,
  thumbs: {} as Record<number, string>,
});

let opened: Opened | null = null;
let meta: ShareMeta | null = null;
let link = "";
let legacyFiles: { name: string; type: string; blob: Blob }[] | null = null;
let legacySingle: Blob | null = null;
const urls = new Set<string>();

const objectUrl = (blob: Blob) => {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
};

export function leaveShare() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  opened = null;
  legacyFiles = null;
  legacySingle = null;
}

export const limited = () => share.downloadsLeft !== null;
export const several = () => (share.items?.length ?? 0) > 1;
export const kindOfEntry = (e: Entry) => previewKind(e.type || mimeFromName(e.name));

/** Whether a file can be shown or saved alone without spending a download of a limited share. */
export function canPick(): boolean {
  if (limited() || !opened) return false;
  return opened.format === 4 || opened.format === 2 || share.size <= LEGACY_BUFFER_MAX_BYTES;
}

function goneWith(why: Gone) {
  share.view = "gone";
  share.gone = why;
}

/** Explains a refusal, or turns the page into the matching dead end. */
function explain(e: unknown): string {
  if (e instanceof DownloadInProgressError) return t("receive.busy");
  if (e instanceof HttpError) {
    if (e.status === 429) return `${t("receive.tooMany")} ${wait(e.retryAfter)}`;
    if (e.status === 404) {
      goneWith(limited() ? "burned" : "missing");
      return "";
    }
  }
  return t("receive.failed");
}

function listEntries(files: { name: string; type: string; size?: number }[]) {
  share.items = files.map((f, index) => ({ index, name: f.name, type: f.type, size: f.size ?? null, done: 0 }));
}

export async function openShare(slug: string, hash: string) {
  leaveShare();
  Object.assign(share, { view: "loading", slug, items: null, error: "", note: "", thumbs: {}, busy: false });
  link = new URLSearchParams(hash.replace(/^#/, "")).get("k") ?? "";
  try {
    const res = await fetch(`/api/d/${encodeURIComponent(slug)}/meta`);
    if (!res.ok) return goneWith("missing");
    meta = (await res.json()) as ShareMeta;
  } catch {
    return goneWith("missing");
  }
  Object.assign(share, { size: meta.size, expiresAt: meta.expiresAt, downloadsLeft: meta.downloadsLeft });
  if (meta.expiresAt !== null && meta.expiresAt <= Date.now()) return goneWith("expired");
  if (meta.downloadsLeft === 0) return goneWith("burned");

  if (isV2Link(link)) {
    let mode: string;
    try {
      mode = decodeToken(link).mode;
    } catch {
      return goneWith("nokey");
    }
    if (mode === "link+password") share.view = "locked";
    else await unlock();
  } else if (link) {
    await unlock();
  } else if (meta.hasPassword && meta.wrappedKey && meta.kdfSalt) {
    share.view = "locked";
  } else {
    goneWith("nokey");
  }
}

/** Derives the keys, from the link and the password when there is one, and lists the files from the uncounted header. */
export async function unlock(password?: string): Promise<boolean> {
  if (!meta) return false;
  share.busy = true;
  share.error = "";
  try {
    if (isV2Link(link)) {
      const keys = await openLink(cryptoWorker, link, meta.format, password);
      if (keys.format !== 4) throw new Error("not a format 4 link");
      const head = await fetchShareHeader(share.slug, keys.keys.verifier);
      const { header } = await cryptoWorker.request({ op: "header", keys: keys.keys, data: head });
      opened = { format: 4, keys: keys.keys };
      share.kind = header.kind;
      listEntries(header.files);
    } else {
      const secret: DownloadSecret = link
        ? { keyFromUrl: link }
        : { password: password ?? "", wrapped: fromBase64(meta.wrappedKey!), salt: fromBase64(meta.kdfSalt!) };
      const key = await cryptoWorker.request({ op: "legacy-key", secret });
      const format = meta.format === 3 ? 3 : 2;
      opened = { format, key, secret };
      share.kind = format === 3 ? "bundle" : "single";
      // An old share whose header does not list still downloads.
      await fetchShareListing(cryptoWorker, share.slug, key, format).then(listEntries, (e: unknown) => {
        if (e instanceof HttpError) throw e;
      });
    }
    share.view = "ready";
    void loadThumbs();
    return true;
  } catch (e) {
    // A wrong password shows as a key that does not unwrap, or as a verifier the server refuses.
    if (share.view === "locked" && (!(e instanceof HttpError) || e.status === 401)) {
      share.error = t("receive.wrong");
    } else {
      share.error = explain(e);
      if (share.view === "loading") share.view = "ready";
    }
    return false;
  } finally {
    share.busy = false;
  }
}

// Counts what a save has read, so the bar follows the bytes.
function counted(stream: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        seen += chunk.length;
        share.progress = size > 0 ? Math.min(1, seen / size) : 0;
        share.phase = "saving";
        markDone(share.progress);
        out.enqueue(chunk);
      },
    }),
  );
}

function markDone(fraction: number) {
  const items = (share.items ?? []).filter((x) => share.only === null || x.index === share.only);
  const all = items.reduce((sum, x) => sum + (x.size ?? 0), 0);
  let left = fraction * all;
  for (const x of items) {
    x.done = Math.min(x.size ?? 0, Math.max(0, left));
    left -= x.size ?? 0;
  }
}

async function save(plaintext: ReadableStream<Uint8Array>, name: string, size?: number) {
  const stream = counted(plaintext, size ?? share.size);
  if (canStreamDownload()) await streamToDownload(stream, name, size);
  else blobDownload(await new Response(stream).blob(), name);
}

async function saveZip(entries: ZipEntry[] | AsyncIterable<ZipEntry>, length: number) {
  const { stream, consumed } = watchConsumed(zipStream(entries));
  await save(stream, `${share.slug}.zip`, length);
  await consumed;
}

// Decrypts a format 3 bundle once and keeps its files, which only an
// unlimited share does: there every later save reuses the one download.
async function bufferLegacy(o: Extract<Opened, { format: 2 | 3 }>) {
  if (legacyFiles) return legacyFiles;
  const body = await fetchShareBlob(share.slug)(o.key.verifier);
  const dl = await decryptBundleInWorker(cryptoWorker, o.key.key, streamToAsyncIterable(body));
  const out: { name: string; type: string; blob: Blob }[] = [];
  for await (const { entry, bytes } of dl.files) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for await (const b of bytes) parts.push(b as Uint8Array<ArrayBuffer>);
    out.push({ name: entry.name, type: entry.type, blob: new Blob(parts, { type: entry.type }) });
  }
  legacyFiles = out;
  return out;
}

async function legacySingleBlob(o: Extract<Opened, { format: 2 | 3 }>) {
  if (legacySingle) return legacySingle;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const { meta: m } = await downloadDecrypted(cryptoWorker, fetchShareBlob(share.slug), o.secret, async (plain) => {
    for await (const b of streamToAsyncIterable(plain)) parts.push(b as Uint8Array<ArrayBuffer>);
  });
  legacySingle = new Blob(parts, { type: m.type });
  return legacySingle;
}

/** Downloads the whole share, a bundle as one ZIP, or reads a note. */
export async function downloadAll(): Promise<number> {
  return run(null, async (o) => {
    if (o.format === 4) {
      if (share.kind === "text") {
        share.note = await readNote(cryptoWorker, fetchShareBlob(share.slug), { keys: o.keys });
        share.view = "note";
        return 0;
      }
      const { header } = await downloadDecryptedV2(cryptoWorker, fetchShareBlob(share.slug), { keys: o.keys }, save, `${share.slug}.zip`);
      return header.files.length;
    }
    if (o.format === 2) {
      if (legacySingle && share.items) blobDownload(legacySingle, share.items[0].name);
      else await downloadDecrypted(cryptoWorker, fetchShareBlob(share.slug), o.secret, (plain, name) => save(plain, name));
      return 1;
    }
    if (canPick()) {
      const files = await bufferLegacy(o);
      const entries = files.map((f) => ({ name: f.name, size: f.blob.size, bytes: streamToAsyncIterable(f.blob.stream()) }));
      await saveZip(entries, zipLength(entries));
      return files.length;
    }
    const body = await fetchShareBlob(share.slug)(o.key.verifier);
    const dl = await decryptBundleInWorker(cryptoWorker, o.key.key, streamToAsyncIterable(body));
    async function* entries(): AsyncGenerator<ZipEntry> {
      for await (const { entry, bytes } of dl.files) yield { name: entry.name, size: entry.size, bytes };
    }
    await saveZip(entries(), zipLength(dl.manifest.files));
    return dl.manifest.files.length;
  });
}

/** Saves one file of an unlimited share alone. */
export async function downloadOne(index: number): Promise<number> {
  return run(index, async (o) => {
    if (o.format === 4) await downloadFileV2(cryptoWorker, share.slug, o.keys, index, save);
    else if (o.format === 2) blobDownload(await legacySingleBlob(o), share.items?.[0]?.name ?? share.slug);
    else {
      const f = (await bufferLegacy(o))[index];
      blobDownload(f.blob, f.name);
    }
    return 1;
  });
}

export const canSaveToFolder = () => "showDirectoryPicker" in window && window.isSecureContext;

// The part of the File System Access API "Save to folder" uses, which lib.dom lacks.
interface FolderHandle {
  getFileHandle(name: string, opts: { create: true }): Promise<{
    createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

/** Writes every file of the share into a folder the person picks. */
export async function saveToFolder(): Promise<number> {
  let dir: FolderHandle;
  try {
    dir = await (window as unknown as { showDirectoryPicker: () => Promise<FolderHandle> }).showDirectoryPicker();
  } catch {
    return 0;
  }
  const write = async (name: string, bytes: AsyncIterable<Uint8Array>) => {
    const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
    for await (const b of bytes) await out.write(b as Uint8Array<ArrayBuffer>);
    await out.close();
  };
  return run(null, async (o) => {
    let n = 0;
    if (o.format === 4) {
      const { header, plaintext } = await decryptInWorker(cryptoWorker, { keys: o.keys }, fetchShareBlob(share.slug));
      for await (const { entry, bytes } of splitByManifest(plaintext, header)) {
        await write(entry.name, bytes);
        n++;
      }
    } else if (canPick()) {
      for (const f of await bufferLegacy(o as Extract<Opened, { format: 2 | 3 }>)) {
        await write(f.name, streamToAsyncIterable(f.blob.stream()));
        n++;
      }
    } else {
      const legacy = o as Extract<Opened, { format: 2 | 3 }>;
      const body = await fetchShareBlob(share.slug)(legacy.key.verifier);
      const dl = await decryptBundleInWorker(cryptoWorker, legacy.key.key, streamToAsyncIterable(body));
      for await (const { entry, bytes } of dl.files) {
        await write(entry.name, bytes);
        n++;
      }
    }
    return n;
  });
}

// Runs one download with its progress, and settles what the share has left.
async function run(only: number | null, work: (o: Opened) => Promise<number>): Promise<number> {
  if (share.busy || (!opened && !(await unlock()))) return 0;
  Object.assign(share, { busy: true, error: "", only, progress: 0, phase: "decrypting", view: "downloading" });
  share.items?.forEach((x) => (x.done = 0));
  try {
    const n = await work(opened!);
    if (share.view === "downloading") share.view = "ready";
    if (only === null && share.downloadsLeft !== null) {
      share.downloadsLeft = Math.max(0, share.downloadsLeft - 1);
      if (share.downloadsLeft === 0 && share.view !== "note") goneWith("burned");
    }
    return n;
  } catch (e) {
    const why = explain(e);
    if (share.view === "downloading") share.view = "ready";
    share.error = why;
    return 0;
  } finally {
    share.busy = false;
  }
}

async function fileBlob(index: number): Promise<Blob> {
  const o = opened!;
  if (o.format === 4) {
    let blob: Blob | null = null;
    await downloadFileV2(cryptoWorker, share.slug, o.keys, index, async (plain) => {
      blob = await new Response(plain).blob();
    });
    return blob!;
  }
  if (o.format === 2) return legacySingleBlob(o);
  return (await bufferLegacy(o))[index].blob;
}

/** Decrypts one file of an unlimited share for its preview, or explains why there is none. */
export async function loadPreview(entry: Entry): Promise<Preview | string> {
  const kind = kindOfEntry(entry);
  if (!kind) return t("receive.noPreview");
  if (!canPick()) return t("receive.previewLimited");
  const size = entry.size ?? share.size;
  try {
    if (kind === "video" && size > PREVIEW_MAX_BYTES) return (await streamingVideo(entry)) ?? t("receive.tooLarge");
    if (size > (kind === "text" ? TEXT_PREVIEW_MAX_BYTES : PREVIEW_MAX_BYTES)) return t("receive.tooLarge");
    const blob = await fileBlob(entry.index);
    if (kind === "text") return { kind, text: new TextDecoder("utf-8", { fatal: false }).decode(await blob.arrayBuffer()) };
    return { kind, url: objectUrl(new Blob([blob], { type: entry.type || mimeFromName(entry.name) || "" })) };
  } catch (e) {
    return explain(e) || t("receive.previewFailed");
  }
}

let previewHandle: PreviewHandle | null = null;

// A large video of a format 2 share plays through the service worker, which
// asks for the decrypted range it needs, so the video is never held whole.
async function streamingVideo(entry: Entry): Promise<Preview | null> {
  const o = opened;
  if (!o || o.format !== 2 || !canStreamPreview()) return null;
  const res = await fetch(`/api/d/${encodeURIComponent(share.slug)}?preview=1`, {
    headers: { "x-fd-key-verifier": o.key.verifier, Range: "bytes=0-8191" },
  });
  if (!res.ok) return null;
  const { meta: m, contentOffset } = await cryptoWorker.request({
    op: "legacy-meta",
    key: o.key.key,
    data: new Uint8Array(await res.arrayBuffer()),
  });
  if (typeof m.size !== "number" || m.size <= 0) return null;
  previewHandle?.release();
  previewHandle = await registerVideoPreview({
    crypto: cryptoWorker,
    downloadUrl: `/api/d/${share.slug}`,
    key: o.key,
    mime: m.type || entry.type,
    size: m.size,
    ciphertextSize: share.size,
    cf: m.cf,
    baseNonce: m.baseNonce ? fromBase64(m.baseNonce) : undefined,
    contentOffset,
  });
  return { kind: "video", url: previewHandle.url };
}

export function closePreview() {
  previewHandle?.release();
  previewHandle = null;
}

// Small images show as their own thumbnail, where looking costs no download.
async function loadThumbs() {
  if (!canPick() || !share.items || (opened?.format === 3)) return;
  for (const entry of share.items) {
    if (kindOfEntry(entry) !== "image" || (entry.size ?? share.size) > THUMB_MAX_BYTES) continue;
    const shown = await loadPreview(entry);
    if (typeof shown === "object" && shown.url) share.thumbs[entry.index] = shown.url;
  }
}
