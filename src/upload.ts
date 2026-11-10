// The parcel being sent: the picked files, their options, and the upload,
// which encrypts with format 4 in the crypto worker while tus sends it. An
// upload keeps a resume record, so one cut off by a reload or a closed tab
// goes on once the same files are picked again.
import * as tus from "tus-js-client";
import { reactive } from "vue";
import { isStrippableType, stripFileMetadata } from "@/lib/exif";
import { allowedExpiryOptions, clampExpiry } from "@/lib/expiry";
import { loadPrefs, savePrefs } from "@/lib/prefs";
import { storedUploadToken, tusUpload } from "@/lib/e2e/tus-upload";
import { resumeUpload, uploadEncrypted, type UploadDeps } from "@/lib/e2e/upload-flow";
import {
  discardPendingUpload,
  indexedDbResumeStore,
  listPendingUploads,
  type PendingUpload,
  type ResumeStore,
} from "@/lib/e2e/upload-resume";
import { isPasswordLongEnough } from "@/lib/e2e/v2/token";
import { cryptoWorker } from "@/lib/e2e/v2/crypto-worker";
import { baseUrl, config } from "@/src/config";
import { wait } from "@/src/format";
import { t } from "@/src/i18n";
import { prefs } from "@/src/prefs";

// The header server-go/internal/upload/auth.go checks, and where the upload
// password stays for this tab. It never goes to localStorage.
const UPLOAD_TOKEN_HEADER = "x-fd-upload-token";
const UPLOAD_TOKEN_KEY = "fd-upload-token";

export type Limit = "none" | "once" | "count";

export interface Item {
  id: number;
  file: File;
  done: number;
}

/** What a finished share shows on the link screen. */
export interface Sent {
  url: string;
  manageUrl: string;
  files: { name: string; size: number }[];
  note: boolean;
  expiry: string;
  maxDownloads: number | null;
  locked: boolean;
  at: number;
}

export const gate = reactive({ token: storedUploadToken(), error: "" });

export const uploadLocked = () => config.uploadProtected && !gate.token;

export function unlockUploads(token: string) {
  gate.token = token;
  gate.error = "";
  try {
    sessionStorage.setItem(UPLOAD_TOKEN_KEY, token);
  } catch {
    // The token stays in memory for this page.
  }
}

function lockUploads() {
  gate.token = "";
  gate.error = t("gate.wrong");
  try {
    sessionStorage.removeItem(UPLOAD_TOKEN_KEY);
  } catch {
    // Nothing was stored.
  }
}

export const authHeaders = (): Record<string, string> => (gate.token ? { [UPLOAD_TOKEN_HEADER]: gate.token } : {});

let ids = 1;

export const send = reactive({
  stage: "home" as "home" | "options" | "uploading" | "done",
  items: [] as Item[],
  expiry: "7d",
  limit: "none" as Limit,
  count: 3,
  locked: false,
  password: "",
  strip: true,
  phase: "encrypting" as "encrypting" | "uploading" | "finishing",
  progress: 0,
  startedAt: 0,
  error: "",
  /** The pending upload the picked files continue, or null for a new one. */
  resuming: null as string | null,
  sent: null as Sent | null,
});

export const total = (items: { size: number }[]) => items.reduce((sum, x) => sum + x.size, 0);
export const sizes = () => send.items.map((x) => ({ name: x.file.name, size: x.file.size }));
export const hasJpeg = () => send.items.some((x) => isStrippableType(x.file.type));
export const expiryChoices = () => allowedExpiryOptions(config.maxExpiry).map((o) => o.value);
export const passwordTooShort = (locked: boolean, password: string) => locked && !isPasswordLongEnough(password);
export const maxDownloads = (limit: Limit, count: number) =>
  limit === "none" ? null : limit === "once" ? 1 : Math.max(1, Math.floor(count || 1));

/** What a new share starts with: the visitor's default, else the server's, within its cap. */
export const startExpiry = () => clampExpiry(prefs.defaultExpiry || config.defaultExpiry || "7d", config.maxExpiry);

function startOptions() {
  const last = prefs.remember ? loadPrefs() : null;
  const limit = last?.maxDownloads ?? null;
  Object.assign(send, {
    expiry: last?.expiry ? clampExpiry(last.expiry, config.maxExpiry) : startExpiry(),
    limit: limit === null ? "none" : limit === 1 ? "once" : "count",
    count: limit !== null && limit > 1 ? limit : 3,
    strip: last?.stripMetadata ?? prefs.stripMetadata,
    locked: false,
    password: "",
  });
}

/** Opens the options of a new parcel, before any file is picked for it. */
export function openOptions() {
  if (send.stage === "options") return;
  startOptions();
  send.stage = "options";
}

export function addFiles(files: File[]) {
  openOptions();
  send.items.push(...files.map((file) => ({ id: ids++, file, done: 0 })));
  send.error = "";
}

export function removeFile(id: number) {
  send.items = send.items.filter((x) => x.id !== id);
}

export function resetSend() {
  Object.assign(send, { stage: "home", items: [], sent: null, error: "", resuming: null, progress: 0 });
}

// A browser without IndexedDB or crypto.subtle, such as one on plain HTTP,
// uploads without resume records.
const store: ResumeStore | null =
  typeof indexedDB !== "undefined" && window.isSecureContext ? indexedDbResumeStore() : null;

/** Whether an upload that breaks off can go on after a reload. */
export const resumable = store !== null;

export const pending = reactive({ list: [] as PendingUpload[] });

export async function loadPending() {
  pending.list = store ? await listPendingUploads(store).catch(() => []) : [];
}

export async function discardPending(id: string) {
  if (store) await discardPendingUpload(store, id);
  await loadPending();
}

/**
 * The network side of an upload. onRecord learns the id of the resume record
 * a new upload writes, which a cancel needs to drop it again.
 */
export function uploadDeps(signal?: AbortSignal, onRecord?: (id: string) => void): UploadDeps {
  const headers = authHeaders();
  const resume: ResumeStore | undefined =
    store && onRecord
      ? {
          ...store,
          put: (rec) => {
            onRecord(rec.id);
            return store.put(rec);
          },
        }
      : (store ?? undefined);
  return {
    baseUrl: baseUrl(),
    crypto: cryptoWorker,
    resume,
    upload: (source, opts) => tusUpload(source, { ...opts, headers, signal }),
    finalize: async (body) => {
      const res = await fetch("/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`finalize ${res.status}`);
      return res.json() as Promise<{ slug: string }>;
    },
  };
}

/** The status and Retry-After of a refusal from tus, finalize or the request route. */
export function refusal(e: unknown): { status: number; retryAfter: number | null } | null {
  if (e instanceof tus.DetailedError && e.originalResponse) {
    const after = Number(e.originalResponse.getHeader("Retry-After"));
    return { status: e.originalResponse.getStatus(), retryAfter: after > 0 ? after : null };
  }
  const m = e instanceof Error ? / (\d{3})$/.exec(e.message) : null;
  return m ? { status: Number(m[1]), retryAfter: null } : null;
}

/** Says why an upload did not go through. A wrong upload password locks the gate again instead. */
export function explainUpload(e: unknown): string {
  const r = refusal(e);
  if (r?.status === 401 && config.uploadProtected) {
    lockUploads();
    return "";
  }
  if (r?.status === 429) return `${t("upload.limit")} ${wait(r.retryAfter)}`;
  if (r?.status === 507) return t("upload.quota");
  if (r?.status === 413) return t("upload.tooLarge");
  return t("upload.failed");
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const isWrongFiles = (e: unknown) => String(e).includes("not the files of this upload");

let stopper: AbortController | null = null;
let record: string | null = null;

function onPhase(phase: "encrypting" | "uploading", fraction: number) {
  send.phase = phase === "uploading" && fraction >= 1 ? "finishing" : phase;
  send.progress = phase === "uploading" ? fraction : 0;
  let left = fraction * total(sizes());
  for (const x of send.items) {
    x.done = Math.min(x.file.size, Math.max(0, left));
    left -= x.file.size;
  }
}

const stripped = (files: File[]) => Promise.all(files.map((f) => stripFileMetadata(f)));

async function resumeOrStripped(id: string, files: File[], deps: UploadDeps) {
  try {
    return await resumeUpload(id, files, deps, onPhase);
  } catch (e) {
    // A share that had its photo metadata removed was fingerprinted without it.
    if (!isWrongFiles(e) || !files.some((f) => isStrippableType(f.type))) throw e;
    return resumeUpload(id, await stripped(files), deps, onPhase);
  }
}

/** Encrypts and uploads the picked files, or continues the pending upload they belong to. */
export async function startUpload() {
  const files = send.items.map((x) => x.file);
  stopper = new AbortController();
  record = send.resuming;
  Object.assign(send, { stage: "uploading", phase: "encrypting", progress: 0, error: "", startedAt: Date.now() });
  send.items.forEach((x) => (x.done = 0));
  const deps = uploadDeps(stopper.signal, (id) => (record = id));
  const limit = maxDownloads(send.limit, send.count);
  try {
    let links: { shareUrl: string; manageUrl: string };
    if (send.resuming) {
      links = await resumeOrStripped(send.resuming, files, deps);
    } else {
      const toSend = send.strip && hasJpeg() ? await stripped(files) : files;
      links = await uploadEncrypted(
        toSend,
        { expiry: send.expiry, maxDownloads: limit, password: send.locked ? send.password : undefined, format: 4 },
        deps,
        onPhase,
      );
      if (prefs.remember) savePrefs({ expiry: send.expiry, maxDownloads: limit, stripMetadata: send.strip });
    }
    send.sent = {
      url: links.shareUrl,
      manageUrl: links.manageUrl,
      files: sizes(),
      note: false,
      expiry: send.expiry,
      maxDownloads: limit,
      locked: send.locked,
      at: Date.now(),
    };
    send.stage = "done";
    send.resuming = null;
  } catch (e) {
    if (isAbort(e)) return;
    if (isWrongFiles(e)) {
      Object.assign(send, { error: t("resume.wrongFiles"), stage: "home", items: [] });
      return;
    }
    send.error = explainUpload(e);
    send.stage = send.resuming || uploadLocked() ? "home" : "options";
  } finally {
    void loadPending();
  }
}

/** Stops the running upload, has the server drop what it received and forgets its resume record. */
export async function cancelUpload() {
  stopper?.abort();
  if (record) await discardPending(record);
  record = null;
  send.stage = send.resuming ? "home" : "options";
  send.resuming = null;
}

/** Continues a pending upload with the files picked again for it. */
export function resumeWith(id: string, files: File[]) {
  send.items = files.map((file) => ({ id: ids++, file, done: 0 }));
  send.resuming = id;
  void startUpload();
}
