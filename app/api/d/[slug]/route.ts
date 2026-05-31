import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { UPLOADS_DIR } from "@/lib/config";
import {
  getFileBySlug,
  incrementDownloadCount,
  type FileRecord,
} from "@/server/db";
import { verifyPassword } from "@/lib/password";
import { downloadToken } from "@/lib/token";

export const runtime = "nodejs";

const COOKIE = "fd_dl";

function isExpired(rec: FileRecord, now = Date.now()): boolean {
  return rec.expires_at !== null && rec.expires_at <= now;
}

// RFC 5987 filename so non-ASCII names survive the Content-Disposition header.
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// GET streams the file. Password-protected shares require the short-lived cookie
// set by a successful POST below.
export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<Response> {
  const rec = getFileBySlug(params.slug);
  if (!rec || isExpired(rec)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (rec.password_hash) {
    // The cookie must carry the token derived from the (server-only) password
    // hash — not the public slug — or anyone with the link could forge it.
    const cookie = _req.cookies.get(COOKIE)?.value;
    if (cookie !== downloadToken(rec.password_hash)) {
      return NextResponse.json({ error: "password required" }, { status: 403 });
    }
  }

  const filePath = join(UPLOADS_DIR, rec.id);
  try {
    await stat(filePath);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  incrementDownloadCount(rec.slug);

  const webStream = Readable.toWeb(
    createReadStream(filePath),
  ) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    headers: {
      "Content-Type": rec.mime ?? "application/octet-stream",
      "Content-Length": String(rec.size),
      "Content-Disposition": contentDisposition(rec.original_name),
      "Cache-Control": "private, no-store",
    },
  });
}

// POST verifies a password and, on success, sets a cookie scoped to this share's
// download path. The client then triggers the GET to stream the file natively.
export async function POST(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const rec = getFileBySlug(params.slug);
  if (!rec || isExpired(rec)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!rec.password_hash) {
    return NextResponse.json({ ok: true }); // not protected, nothing to verify
  }

  let password = "";
  try {
    password = ((await req.json()) as { password?: string }).password ?? "";
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!verifyPassword(password, rec.password_hash)) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, downloadToken(rec.password_hash), {
    path: `/api/d/${rec.slug}`,
    httpOnly: true,
    sameSite: "strict",
    maxAge: 300,
  });
  return res;
}
