import { NextRequest, NextResponse } from "next/server";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_EXPIRY,
  ENCRYPT_UPLOADS,
  MASTER_KEY,
  SERVER_KEY_MODE,
  TMP_DIR,
  UPLOADS_DIR,
  ensureDataDirs,
} from "@/lib/config";
import { isSafeId, newSlug } from "@/lib/ids";
import { isUploadComplete } from "@/lib/upload";
import { parseMaxDownloads } from "@/lib/downloads";
import { chooseEncMode } from "@/lib/encmode";
import { isValidExpiry, expiryToTimestamp } from "@/lib/expiry";
import { isValidKeyVerifier } from "@/lib/key-verifier";
import { mimeFromName } from "@/lib/mime";
import { hashPassword } from "@/lib/password";
import { createFileRecord, getFileBySlug } from "@/server/db";
import { encryptStream, wrapKey } from "@/server/crypto";

export const runtime = "nodejs";

interface FinalizeBody {
  uploadId?: string;
  expiry?: string;
  password?: string;
  maxDownloads?: number; // optional download limit; null/absent = unlimited
  // v2 zero-knowledge fields (Phase 7b)
  // 2 = zero-knowledge single file; 3 = zero-knowledge multi-file (manifest
  // blob); absent/1 = v1 legacy. Formats 2 and 3 are byte-store-identical here —
  // the server just records which client-side blob layout it holds.
  format?: number;
  wrappedKey?: string; // base64-encoded: content key wrapped with Argon2id-derived KEK (password mode)
  kdfSalt?: string; // base64-encoded: 16-byte Argon2id salt (password mode)
  // base64url(SHA-256(content key)) — download authorization (one-way; the
  // server can never recover the key from it). Optional for backward
  // compatibility, but our client always sends it for format=2 uploads.
  keyVerifier?: string;
}

// Read the tus upload's metadata sidecar (<id>.json, written by @tus/file-store's
// FileConfigstore next to the binary): the original filename + content type (so
// we keep the real name on download) and size/offset (so we can confirm the
// upload actually finished before publishing it).
interface TusSidecar {
  size?: number;
  offset?: number;
  metadata?: { filename?: string; filetype?: string };
}

async function readTusSidecar(uploadId: string): Promise<TusSidecar | null> {
  try {
    const raw = await readFile(join(TMP_DIR, `${uploadId}.json`), "utf8");
    return JSON.parse(raw) as TusSidecar;
  } catch {
    return null;
  }
}

function uniqueSlug(): string {
  // Collisions are astronomically unlikely, but never return a dupe.
  for (let i = 0; i < 5; i++) {
    const slug = newSlug();
    if (!getFileBySlug(slug)) return slug;
  }
  throw new Error("could not allocate a unique slug");
}

// Encrypt the completed plaintext upload into the store with age, removing the
// plaintext temp afterwards. Returns the per-file key (an age identity).
async function encryptIntoStore(
  tmpPath: string,
  storedPath: string,
  header: { name: string; mime: string | null },
): Promise<string> {
  const source = Readable.toWeb(
    createReadStream(tmpPath),
  ) as ReadableStream<Uint8Array>;
  const { ciphertext, key } = await encryptStream(source, header);
  try {
    await pipeline(
      Readable.fromWeb(ciphertext as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(storedPath),
    );
  } catch (err) {
    // A mid-stream failure (e.g. disk full) would otherwise leave a partial,
    // orphaned ciphertext with no DB row. Remove it; the plaintext temp stays so
    // the upload itself is not lost.
    await rm(storedPath, { force: true });
    throw err;
  }
  await rm(tmpPath, { force: true });
  return key;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  ensureDataDirs();

  let body: FinalizeBody;
  try {
    body = (await req.json()) as FinalizeBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const uploadId = body.uploadId;
  if (!uploadId || !isSafeId(uploadId)) {
    return NextResponse.json({ error: "invalid uploadId" }, { status: 400 });
  }

  const expiry = body.expiry ?? "";
  if (expiry && !isValidExpiry(expiry)) {
    return NextResponse.json({ error: "invalid expiry" }, { status: 400 });
  }

  // Key verifier (format=2 download authorization): optional, but when present
  // it must be exactly base64url(SHA-256(K)) shaped — 43 unpadded base64url
  // chars. Validated here, BEFORE any file is moved, so a 400 has no side
  // effects and the tus upload survives for a corrected retry.
  if (body.keyVerifier !== undefined && !isValidKeyVerifier(body.keyVerifier)) {
    return NextResponse.json({ error: "invalid keyVerifier" }, { status: 400 });
  }

  const tmpPath = join(TMP_DIR, uploadId);
  let size: number;
  try {
    size = (await stat(tmpPath)).size;
  } catch {
    return NextResponse.json({ error: "upload not found" }, { status: 404 });
  }

  // Refuse to publish an upload tus has not finished receiving — otherwise an
  // early finalize call (buggy/malicious client) would share a partial file.
  // Judge completeness from the ACTUAL on-disk byte count (`size`) against the
  // declared Upload-Length — NOT the sidecar's `offset`, which tus leaves frozen
  // at 0 (see lib/upload.ts), which previously 409'd every non-empty upload.
  const sidecar = await readTusSidecar(uploadId);
  if (sidecar && !isUploadComplete(size, sidecar.size)) {
    return NextResponse.json({ error: "upload not complete" }, { status: 409 });
  }

  const storedId = uploadId;
  const storedPath = join(UPLOADS_DIR, storedId);
  const slug = uniqueSlug();

  // -------------------------------------------------------------------------
  // v2 zero-knowledge path (Phase 7b) — formats 2 (single file) and 3 (multi-
  // file manifest blob).
  // The browser already encrypted the blob before uploading via tus. The server
  // is a dumb byte store: it renames the tmp file to its final location without
  // any server-side crypto, stores the optional wrapped_key/kdf_salt (password
  // mode) or neither (link mode), and returns only the slug — the key lives in
  // the URL fragment or is derived by the browser from the user's password. The
  // file COUNT is invisible to the server: format 3 is handled identically to 2,
  // only the recorded `format` differs (the download page reads it to unpack).
  // -------------------------------------------------------------------------
  if (body.format === 2 || body.format === 3) {
    // Move the already-encrypted blob to its final location (no crypto at all).
    await rename(tmpPath, storedPath);
    // Decode base64 → Buffer (null when absent — link mode).
    const wrapped_key = body.wrappedKey
      ? Buffer.from(body.wrappedKey, "base64")
      : null;
    const kdf_salt = body.kdfSalt
      ? Buffer.from(body.kdfSalt, "base64")
      : null;
    // Sidecar cleanup (same as v1 path).
    await rm(join(TMP_DIR, `${uploadId}.json`), { force: true });

    createFileRecord({
      id: storedId,
      slug,
      original_name: "", // server does not know the real filename
      size,
      mime: null, // server does not know the MIME type
      password_hash: null, // password never reaches the server in v2
      expires_at: expiryToTimestamp(expiry || DEFAULT_EXPIRY),
      created_at: Date.now(),
      max_downloads: parseMaxDownloads(body.maxDownloads),
      encrypted: 0, // v1 age-encryption flag unused in v2
      enc_mode: null,
      enc_key_wrapped: null,
      format: body.format, // 2 (single file) or 3 (multi-file manifest)
      wrapped_key,
      kdf_salt,
      // NULL when an (older) client sent none — such shares download without
      // proof, exactly like pre-verifier uploads.
      key_verifier: body.keyVerifier ?? null,
    });

    // The client already holds the key (link: URL fragment it generated;
    // password: it just sent wrapped_key+kdf_salt and will reconstruct).
    // No key in the response — zero knowledge.
    return NextResponse.json({ slug });
  }

  // -------------------------------------------------------------------------
  // v1 legacy path — unchanged
  // -------------------------------------------------------------------------

  const meta = sidecar?.metadata ?? {};
  const originalName = (meta.filename ?? "download").slice(0, 255);
  // Trust the browser-supplied type, but fall back to the filename extension
  // when it is missing/empty — otherwise such a file would never preview, since
  // the preview gate and the inline Content-Type both key off a known MIME.
  const mime = meta.filetype?.trim() || mimeFromName(originalName);

  const password = body.password?.trim();

  // Encryption (default on). The file is encrypted to a fresh per-file key;
  // what happens to that key is the mode (see lib/encmode.ts):
  //   - password -> wrap with the password, store only the wrap.
  //   - server   -> wrap with the server master key, store the wrap (short link).
  //   - link     -> hand the key back so it rides in the share #fragment.
  let encrypted = 0;
  let encMode: string | null = null;
  let encKeyWrapped: string | null = null;
  let linkKey: string | undefined;

  if (ENCRYPT_UPLOADS) {
    const key = await encryptIntoStore(tmpPath, storedPath, {
      name: originalName,
      mime,
    });
    encrypted = 1;
    const mode = chooseEncMode(Boolean(password), SERVER_KEY_MODE);
    encMode = mode;
    if (mode === "password") {
      encKeyWrapped = await wrapKey(key, password as string);
    } else if (mode === "server") {
      encKeyWrapped = await wrapKey(key, MASTER_KEY);
    } else {
      linkKey = key; // link mode: key travels in the URL fragment
    }
  } else {
    // Plaintext fallback: just move the upload into the store.
    await rename(tmpPath, storedPath);
  }
  await rm(join(TMP_DIR, `${uploadId}.json`), { force: true });

  createFileRecord({
    id: storedId,
    slug,
    original_name: originalName,
    size,
    mime,
    password_hash: password ? hashPassword(password) : null,
    expires_at: expiryToTimestamp(expiry || DEFAULT_EXPIRY),
    created_at: Date.now(),
    max_downloads: parseMaxDownloads(body.maxDownloads),
    encrypted,
    enc_mode: encMode,
    enc_key_wrapped: encKeyWrapped,
    // v2 zero-knowledge fields — not used by the v1 finalize path.
    format: 1,
    wrapped_key: null,
    kdf_salt: null,
    key_verifier: null,
  });

  // The link key (link mode) goes to the uploader only, in the JSON response —
  // the client appends it to the share URL as a #fragment, which never reaches
  // the server. It is intentionally absent for password-protected shares.
  return NextResponse.json(linkKey ? { slug, key: linkKey } : { slug });
}
