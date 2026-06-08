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

  const meta = sidecar?.metadata ?? {};
  const originalName = (meta.filename ?? "download").slice(0, 255);
  // Trust the browser-supplied type, but fall back to the filename extension
  // when it is missing/empty — otherwise such a file would never preview, since
  // the preview gate and the inline Content-Type both key off a known MIME.
  const mime = meta.filetype?.trim() || mimeFromName(originalName);

  const storedId = uploadId;
  const storedPath = join(UPLOADS_DIR, storedId);
  const slug = uniqueSlug();
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
  });

  // The link key (link mode) goes to the uploader only, in the JSON response —
  // the client appends it to the share URL as a #fragment, which never reaches
  // the server. It is intentionally absent for password-protected shares.
  return NextResponse.json(linkKey ? { slug, key: linkKey } : { slug });
}
