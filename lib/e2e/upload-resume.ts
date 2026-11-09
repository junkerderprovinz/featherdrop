// What a format 4 upload keeps so it can go on after a reload or a closed tab:
// the tus upload URL and what reproduces the rest of the ciphertext, which is
// the content key, the sealed header, the link token and the verifier. The
// password is not kept; the content key and the sealed header are all a
// resume needs.
//
// That part is sealed with AES-GCM under a non-extractable key stored in the
// same record, so neither the key nor the link nor a file name sits in storage
// as readable bytes. Any script of this origin can still use the key, so a
// record lives only as long as its upload: it is deleted once the share is
// finalized, when the user discards it, and once it is older than the server
// keeps an unfinished upload.

import { toBase64, fromBase64 } from "./base64";
import type { BlobState, Header } from "./v2/layout";

/** One pending upload as stored. Only id, touchedAt and uploadUrl are readable. */
export interface ResumeRecord {
  id: string;
  /** Last activity in ms since the epoch. */
  touchedAt: number;
  uploadUrl: string | null;
  /** Non-extractable AES-GCM key that sealed `sealed`. */
  key: CryptoKey;
  /** iv(12) || AES-GCM(JSON of the resume state), with the id as associated data. */
  sealed: Uint8Array<ArrayBuffer>;
}

/** Where records live: IndexedDB in the browser, a Map in tests. */
export interface ResumeStore {
  get(id: string): Promise<ResumeRecord | undefined>;
  put(rec: ResumeRecord): Promise<void>;
  delete(id: string): Promise<void>;
  all(): Promise<ResumeRecord[]>;
}

/** Tells a picked file apart from another with the same name, size and date. */
export interface FileFingerprint {
  name: string;
  size: number;
  lastModified: number;
  /** SHA-256 of evenly spaced samples of the content, base64. */
  sample: string;
}

export interface ResumeState {
  token: string;
  verifier: string;
  blob: BlobState;
  /** In content order. */
  files: FileFingerprint[];
  expiry: string;
  maxDownloads: number | null;
}

export interface PendingUpload {
  id: string;
  touchedAt: number;
  files: { name: string; size: number }[];
}

// The server drops a tus upload untouched for this long (StaleUploadAge in
// server-go/internal/cleanup), so its record could not resume anyway.
const STALE_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;
const SAMPLES = 16;
const SAMPLE_BYTES = 4096;

const utf8 = new TextEncoder();

/** Hashes 16 blocks of 4 KiB spread over the file, at most 64 KiB read. */
async function sampleFile(file: Blob): Promise<string> {
  const parts: Blob[] = [];
  if (file.size <= SAMPLES * SAMPLE_BYTES) {
    parts.push(file);
  } else {
    const step = (file.size - SAMPLE_BYTES) / (SAMPLES - 1);
    for (let k = 0; k < SAMPLES; k++) {
      const at = Math.floor(k * step);
      parts.push(file.slice(at, at + SAMPLE_BYTES));
    }
  }
  const data = await new Blob(parts).arrayBuffer();
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export async function fingerprintFiles(files: File[]): Promise<FileFingerprint[]> {
  return Promise.all(
    files.map(async (f) => ({ name: f.name, size: f.size, lastModified: f.lastModified, sample: await sampleFile(f) })),
  );
}

/**
 * Puts the picked files into the order of the recorded ones. Browsers keep no
 * file handles across a reload, so the user picks the files again and each
 * must match a recorded one in name, size, date and content samples.
 */
export async function matchFiles(recorded: FileFingerprint[], picked: File[]): Promise<File[]> {
  const refuse = () => new Error("upload resume: these are not the files of this upload");
  if (picked.length !== recorded.length) throw refuse();
  const left = [...picked];
  const out: File[] = [];
  for (const want of recorded) {
    const i = left.findIndex((f) => f.name === want.name && f.size === want.size && f.lastModified === want.lastModified);
    if (i < 0) throw refuse();
    const [file] = left.splice(i, 1);
    if ((await fingerprintFiles([file]))[0].sample !== want.sample) throw refuse();
    out.push(file);
  }
  return out;
}

function encodeState(s: ResumeState): Uint8Array {
  const { prefix, header, contentKey } = s.blob;
  return utf8.encode(
    JSON.stringify({ ...s, blob: { prefix: toBase64(prefix), header, contentKey: toBase64(contentKey) } }),
  );
}

function decodeState(bytes: Uint8Array): ResumeState {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as Omit<ResumeState, "blob"> & {
    blob: { prefix: string; header: Header; contentKey: string };
  };
  const { prefix, header, contentKey } = raw.blob;
  return { ...raw, blob: { prefix: fromBase64(prefix), header, contentKey: fromBase64(contentKey) } };
}

/** Stores the state of a new upload and returns its record id. */
export async function rememberUpload(store: ResumeStore, state: ResumeState): Promise<string> {
  const id = crypto.randomUUID();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(id) },
    key,
    encodeState(state) as Uint8Array<ArrayBuffer>,
  );
  const sealed = new Uint8Array(12 + ct.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ct), 12);
  await store.put({ id, touchedAt: Date.now(), uploadUrl: null, key, sealed });
  return id;
}

async function openRecord(rec: ResumeRecord): Promise<ResumeState> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: rec.sealed.subarray(0, 12), additionalData: utf8.encode(rec.id) },
    rec.key,
    rec.sealed.subarray(12),
  );
  return decodeState(new Uint8Array(plain));
}

/** The state and the tus upload URL of a pending upload. */
export async function recallUpload(
  store: ResumeStore,
  id: string,
): Promise<{ state: ResumeState; uploadUrl: string | null }> {
  const rec = await store.get(id);
  if (!rec) throw new Error("upload resume: no such pending upload");
  return { state: await openRecord(rec), uploadUrl: rec.uploadUrl };
}

/**
 * Keeps a record current while its upload runs. Writes run one after another
 * so the final delete cannot be overtaken by a late update that would bring
 * the record back.
 */
export function trackUpload(store: ResumeStore, id: string) {
  let chain = Promise.resolve();
  let lastWrite = Date.now();
  const update = (change: Partial<Pick<ResumeRecord, "uploadUrl">>) => {
    lastWrite = Date.now();
    chain = chain
      .then(async () => {
        const rec = await store.get(id);
        if (rec) await store.put({ ...rec, ...change, touchedAt: Date.now() });
      })
      // A storage failure costs the resume, not the upload.
      .catch(() => {});
    return chain;
  };
  return {
    setUploadUrl: (url: string) => update({ uploadUrl: url }),
    touch: () => {
      if (Date.now() - lastWrite >= TOUCH_EVERY_MS) void update({});
    },
    async done() {
      await chain;
      await store.delete(id);
    },
  };
}

/**
 * The uploads that can still be resumed, oldest first. Records the server has
 * already given up on, and records that no longer open, are deleted.
 */
export async function listPendingUploads(store: ResumeStore, now = Date.now()): Promise<PendingUpload[]> {
  const out: PendingUpload[] = [];
  for (const rec of await store.all()) {
    let state: ResumeState | null = null;
    if (now - rec.touchedAt < STALE_MS) state = await openRecord(rec).catch(() => null);
    if (!state) {
      await store.delete(rec.id);
      continue;
    }
    out.push({ id: rec.id, touchedAt: rec.touchedAt, files: state.files.map(({ name, size }) => ({ name, size })) });
  }
  return out.sort((a, b) => a.touchedAt - b.touchedAt);
}

export async function discardPendingUpload(store: ResumeStore, id: string): Promise<void> {
  await store.delete(id);
}

/** A ResumeStore in IndexedDB, opened on first use. */
export function indexedDbResumeStore(name = "cp-uploads"): ResumeStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pending", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const tx = (await open()).transaction("pending", mode);
    const req = op(tx.objectStore("pending"));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    get: (id) => run("readonly", (s) => s.get(id) as IDBRequest<ResumeRecord | undefined>),
    put: async (rec) => void (await run("readwrite", (s) => s.put(rec))),
    delete: async (id) => void (await run("readwrite", (s) => s.delete(id))),
    all: () => run("readonly", (s) => s.getAll() as IDBRequest<ResumeRecord[]>),
  };
}
