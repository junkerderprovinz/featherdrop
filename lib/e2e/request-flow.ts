// The network side of file requests (./v2/request.ts holds the keys). The
// requester creates a request and keeps the collect link; whoever has the
// request link sends files or a note; the requester lists, downloads and
// closes with the collect link. fetch, the tus upload and the crypto worker
// are injected for tests.

import { toBase64, fromBase64 } from "./crypto";
import { hashManageToken } from "./manage-link";
import { noteContent } from "./note";
import { readFiles, type UploadSource } from "./upload-flow";
import { openKeys, readHeader, type FileEntry, type Header } from "./v2/share";
import { workerBlobSource } from "./v2/remote";
import type { Client } from "./v2/protocol";
import type { ShareKeys } from "./v2/keys";
import {
  newRequestSecret,
  requestKeys,
  encodeCollectLink,
  decodeCollectLink,
  encodeRequestKey,
  decodeRequestKey,
  requestKeyProof,
  sealToken,
  openSealedToken,
} from "./v2/request";

const REQUEST_HEADER = "x-fd-request";
const REQUEST_KEY_HEADER = "x-fd-request-key";
const COLLECT_TOKEN_HEADER = "x-fd-collect-token";
const UPLOAD_TOKEN_HEADER = "x-fd-upload-token";

/** What the request link names: the request and the key uploads are sealed to. */
export interface RequestLink {
  slug: string;
  publicKey: Uint8Array;
}

/** What the collect link names: the request and the secret everything else derives from. */
export interface CollectLink {
  slug: string;
  secret: Uint8Array;
}

/** The request no longer takes uploads: it is full. */
export class RequestClosedError extends Error {
  constructor() {
    super("request closed");
    this.name = "RequestClosedError";
  }
}

/** The encrypted upload would be larger than the request allows. */
export class RequestTooLargeError extends Error {
  constructor(readonly maxSize: number) {
    super("upload larger than the request allows");
    this.name = "RequestTooLargeError";
  }
}

/** The request is unknown, expired or the link is incomplete; the server tells these apart for no one. */
export class RequestNotFoundError extends Error {
  constructor() {
    super("request not found");
    this.name = "RequestNotFoundError";
  }
}

function fragmentValue(url: string, name: string): { slug: string; value: string; path: string } {
  const u = new URL(url, "https://placeholder.invalid");
  const parts = u.pathname.split("/").filter(Boolean);
  const value = new URLSearchParams(u.hash.replace(/^#/, "")).get(name) ?? "";
  return { path: parts[0] ?? "", slug: decodeURIComponent(parts[1] ?? ""), value };
}

/** Reads a request link, https://host/r/<slug>#p=<key>. */
export function parseRequestUrl(url: string): RequestLink {
  const { path, slug, value } = fragmentValue(url, "p");
  if (path !== "r" || !slug || !value) throw new Error("not a request link");
  try {
    return { slug, publicKey: decodeRequestKey(value) };
  } catch {
    throw new Error("not a request link");
  }
}

/** Reads a collect link, https://host/c/<slug>#c=<secret>. */
export function parseCollectUrl(url: string): CollectLink {
  const { path, slug, value } = fragmentValue(url, "c");
  if (path !== "c" || !slug || !value) throw new Error("not a collect link");
  try {
    return { slug, secret: decodeCollectLink(value) };
  } catch {
    throw new Error("not a collect link");
  }
}

/** The request link of a request, rebuilt from its collect link. */
export async function requestUrl(baseUrl: string, collect: CollectLink): Promise<string> {
  const { publicKey } = await requestKeys(collect.secret);
  return `${baseUrl}/r/${encodeURIComponent(collect.slug)}#p=${encodeRequestKey(publicKey)}`;
}

function collectUrl(baseUrl: string, collect: CollectLink): string {
  return `${baseUrl}/c/${encodeURIComponent(collect.slug)}#c=${encodeCollectLink(collect.secret)}`;
}

/**
 * Opens a file request. Only the public key and the hash of the collect token
 * leave the browser. The requester keeps the collect link; the request link
 * goes to whoever should send files.
 */
export async function createRequest(
  opts: { expiry: string; maxUploads: number | null; maxSize: number | null },
  deps: { baseUrl: string; fetchImpl?: typeof fetch; uploadToken?: string },
): Promise<{ requestUrl: string; collectUrl: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secret = await newRequestSecret();
  const keys = await requestKeys(secret);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.uploadToken) headers[UPLOAD_TOKEN_HEADER] = deps.uploadToken;
  const res = await fetchImpl("/api/requests", {
    method: "POST",
    headers,
    body: JSON.stringify({
      publicKey: requestKeyProof(keys.publicKey),
      collectTokenHash: await hashManageToken(keys.collectToken),
      expiry: opts.expiry,
      maxUploads: opts.maxUploads,
      maxSize: opts.maxSize,
    }),
  });
  if (!res.ok) throw new Error(`create request ${res.status}`);
  const { slug } = (await res.json()) as { slug: string };
  const collect = { slug, secret };
  return { requestUrl: await requestUrl(deps.baseUrl, collect), collectUrl: collectUrl(deps.baseUrl, collect) };
}

function uploaderHeaders(link: RequestLink): Record<string, string> {
  return { [REQUEST_KEY_HEADER]: requestKeyProof(link.publicKey) };
}

export interface RequestInfo {
  expiresAt: number | null;
  /** The largest encrypted upload the request takes, null for the server's limit. */
  maxSize: number | null;
  open: boolean;
}

/** What an uploader may know about a request. */
export async function fetchRequestInfo(link: RequestLink, fetchImpl: typeof fetch = fetch): Promise<RequestInfo> {
  const res = await fetchImpl(`/api/r/${encodeURIComponent(link.slug)}`, { headers: uploaderHeaders(link) });
  if (res.status === 404) throw new RequestNotFoundError();
  if (!res.ok) throw new Error(`request ${res.status}`);
  return (await res.json()) as RequestInfo;
}

export interface SendDeps {
  /** Uploads with tus, sending headers with every tus request, and resolves to the upload id. */
  upload(
    source: UploadSource,
    opts: { headers: Record<string, string>; onProgress: (sent: number, total: number) => void },
  ): Promise<string>;
  /** The crypto worker that makes the share's keys and seals its chunks. */
  crypto: Client;
  fetchImpl?: typeof fetch;
}

/**
 * Encrypts files, or a note when content is a string, as a fresh link-mode
 * share, uploads it for the request and attaches the share's link token
 * sealed to the request's public key. The chunks are sealed in the crypto
 * worker as tus sends them. The uploader keeps no link: once sent, only the
 * collect link opens the upload.
 */
export async function sendToRequest(
  content: File[] | string,
  link: RequestLink,
  deps: SendDeps,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const info = await fetchRequestInfo(link, fetchImpl);
  if (!info.open) throw new RequestClosedError();

  let entries: FileEntry[];
  let plain: Blob[];
  if (typeof content === "string") {
    const { bytes, entry } = noteContent(content);
    entries = [entry];
    plain = [new Blob([bytes])];
  } else {
    if (content.length === 0) throw new Error("sendToRequest: no files given");
    entries = content.map((f) => ({ name: f.name, type: f.type || "application/octet-stream", size: f.size }));
    plain = content;
  }
  const { token, state } = await deps.crypto.request({
    op: "create",
    files: entries,
    kind: typeof content === "string" ? "text" : undefined,
  });
  const source = workerBlobSource(deps.crypto, state, readFiles(plain));
  if (info.maxSize !== null && source.size > info.maxSize) throw new RequestTooLargeError(info.maxSize);

  onProgress?.(0);
  const uploadId = await deps.upload(source, {
    headers: { [REQUEST_HEADER]: link.slug, ...uploaderHeaders(link) },
    onProgress: (sent, total) => onProgress?.(total > 0 ? sent / total : 0),
  });
  const sealed = await sealToken(token, link.publicKey);
  const res = await fetchImpl(`/api/r/${encodeURIComponent(link.slug)}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...uploaderHeaders(link) },
    body: JSON.stringify({ uploadId, sealedKey: toBase64(sealed) }),
  });
  if (res.status === 410) throw new RequestClosedError();
  if (res.status === 413) throw new RequestTooLargeError(info.maxSize ?? 0);
  if (res.status === 404) throw new RequestNotFoundError();
  if (!res.ok) throw new Error(`send ${res.status}`);
  onProgress?.(1);
}

async function collectHeaders(collect: CollectLink): Promise<Record<string, string>> {
  return { [COLLECT_TOKEN_HEADER]: (await requestKeys(collect.secret)).collectToken };
}

function uploadPath(collect: CollectLink, id: string): string {
  return `/api/r/${encodeURIComponent(collect.slug)}/uploads/${encodeURIComponent(id)}`;
}

/**
 * One upload as the requester sees it. A readable one has its header open;
 * an unreadable one carries a sealed key or header that does not open, which
 * anyone with the request link can send, and can only be deleted.
 */
export type CollectedUpload = {
  id: string;
  /** Encrypted size in bytes. */
  size: number;
  createdAt: number;
} & ({ readable: true; keys: ShareKeys; header: Header } | { readable: false });

export interface Collection {
  expiresAt: number | null;
  maxUploads: number | null;
  maxSize: number | null;
  uploads: CollectedUpload[];
}

/**
 * Lists a request's uploads for the holder of its collect link: unseals each
 * upload's link token and opens its header, so names and sizes show without
 * downloading the content. An upload whose token or header does not open is
 * listed as unreadable, so one bad upload cannot hide the others.
 */
export async function listRequestUploads(collect: CollectLink, fetchImpl: typeof fetch = fetch): Promise<Collection> {
  const keys = await requestKeys(collect.secret);
  const headers = await collectHeaders(collect);
  const res = await fetchImpl(`/api/r/${encodeURIComponent(collect.slug)}/uploads`, { headers });
  if (res.status === 404) throw new RequestNotFoundError();
  if (!res.ok) throw new Error(`collect ${res.status}`);
  const listing = (await res.json()) as Omit<Collection, "uploads"> & {
    uploads: { id: string; size: number; createdAt: number; sealedKey: string }[];
  };
  const uploads: CollectedUpload[] = [];
  for (const up of listing.uploads) {
    const base = { id: up.id, size: up.size, createdAt: up.createdAt };
    try {
      const token = await openSealedToken(fromBase64(up.sealedKey), keys);
      const shareKeys = await openKeys(token);
      const head = await fetchImpl(`${uploadPath(collect, up.id)}/header`, { headers });
      if (!head.ok) throw new Error(`upload header ${head.status}`);
      const { header } = readHeader(shareKeys, new Uint8Array(await head.arrayBuffer()));
      uploads.push({ ...base, readable: true, keys: shareKeys, header });
    } catch {
      uploads.push({ ...base, readable: false });
    }
  }
  return { expiresAt: listing.expiresAt, maxUploads: listing.maxUploads, maxSize: listing.maxSize, uploads };
}

/** A fetchBlob for downloadDecryptedV2 and readNote that reads one upload of a request. */
export function fetchUploadBlob(
  collect: CollectLink,
  id: string,
  fetchImpl: typeof fetch = fetch,
): (keyVerifier: string) => Promise<ReadableStream<Uint8Array>> {
  return async () => {
    const res = await fetchImpl(uploadPath(collect, id), { headers: await collectHeaders(collect) });
    if (!res.ok || !res.body) throw new Error(`upload ${res.status}`);
    return res.body;
  };
}

/** Deletes one upload of a request. "notfound" covers an upload already gone. */
export async function deleteRequestUpload(
  collect: CollectLink,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"deleted" | "notfound"> {
  const res = await fetchImpl(uploadPath(collect, id), { method: "DELETE", headers: await collectHeaders(collect) });
  if (res.status === 404) return "notfound";
  if (!res.ok) throw new Error(`delete upload ${res.status}`);
  return "deleted";
}

/** Deletes a request and its uploads. "notfound" covers a request already gone. */
export async function closeRequest(collect: CollectLink, fetchImpl: typeof fetch = fetch): Promise<"closed" | "notfound"> {
  const res = await fetchImpl(`/api/r/${encodeURIComponent(collect.slug)}`, {
    method: "DELETE",
    headers: await collectHeaders(collect),
  });
  if (res.status === 404) return "notfound";
  if (!res.ok) throw new Error(`close request ${res.status}`);
  return "closed";
}
