import { NextRequest, NextResponse } from "next/server";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXPIRY, TMP_DIR, UPLOADS_DIR, ensureDataDirs } from "@/lib/config";
import { isSafeId, newSlug } from "@/lib/ids";
import { isValidExpiry, expiryToTimestamp } from "@/lib/expiry";
import { hashPassword } from "@/lib/password";
import { createFileRecord, getFileBySlug } from "@/server/db";

export const runtime = "nodejs";

interface FinalizeBody {
  uploadId?: string;
  expiry?: string;
  password?: string;
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
  const sidecar = await readTusSidecar(uploadId);
  if (
    sidecar &&
    typeof sidecar.size === "number" &&
    typeof sidecar.offset === "number" &&
    sidecar.offset < sidecar.size
  ) {
    return NextResponse.json({ error: "upload not complete" }, { status: 409 });
  }

  const meta = sidecar?.metadata ?? {};
  const originalName = (meta.filename ?? "download").slice(0, 255);
  const mime = meta.filetype ?? null;

  // Move the completed upload into the permanent store, keyed by its tus id.
  const storedId = uploadId;
  await rename(tmpPath, join(UPLOADS_DIR, storedId));
  await rm(join(TMP_DIR, `${uploadId}.json`), { force: true });

  const slug = uniqueSlug();
  const password = body.password?.trim();

  createFileRecord({
    id: storedId,
    slug,
    original_name: originalName,
    size,
    mime,
    password_hash: password ? hashPassword(password) : null,
    expires_at: expiryToTimestamp(expiry || DEFAULT_EXPIRY),
    created_at: Date.now(),
  });

  return NextResponse.json({ slug });
}
