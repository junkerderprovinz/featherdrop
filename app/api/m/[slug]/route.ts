import { NextRequest, NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UPLOADS_DIR } from "@/lib/config";
import { manageTokenMatches } from "@/lib/manage-token";
import { downloadsLeft } from "@/lib/downloads";
import {
  deleteFileBySlug,
  getFileBySlug,
  type FileRecord,
} from "@/server/db";

export const runtime = "nodejs";

// Header the management link's client attaches the raw delete token to. The
// token is read from the URL #fragment client-side and sent here — NOT in the
// request path — so it never lands in server/proxy access logs.
const MANAGE_TOKEN_HEADER = "x-fd-manage-token";

function isExpired(rec: FileRecord, now = Date.now()): boolean {
  return rec.expires_at !== null && rec.expires_at <= now;
}

// Authorize a management request: the share must exist, not be expired, carry a
// stored manage_token_hash (legacy/null shares are NOT manageable), and the
// header token must hash to that stored hash (constant-time). On any failure we
// return null so the caller can respond with a UNIFORM 404 — never revealing
// whether the slug exists, whether it's legacy, or whether the token was wrong.
function authorize(req: NextRequest, slug: string): FileRecord | null {
  const rec = getFileBySlug(slug);
  if (!rec || isExpired(rec)) return null;
  const token = req.headers.get(MANAGE_TOKEN_HEADER) ?? undefined;
  if (!manageTokenMatches(token, rec.manage_token_hash)) return null;
  return rec;
}

// GET: report the share's status (expiry + downloads left) to an authorized
// uploader so the manage page can show it. Authorized ONLY by the manage-token
// header (the same secret used to delete) — never counts or burns a download,
// and never touches the file. Unauthorized/unknown/legacy → uniform 404.
export function GET(
  req: NextRequest,
  { params }: { params: { slug: string } },
): NextResponse {
  const rec = authorize(req, params.slug);
  if (!rec) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    size: rec.size,
    expiresAt: rec.expires_at,
    downloadsLeft: downloadsLeft(rec.download_count, rec.max_downloads),
  });
}

// DELETE: revoke a share early. The uploader proves ownership with the
// manage-token header; on a match we remove the blob from disk AND the DB row
// (reusing the cleanup deletion pattern: rm the file, then drop the row). No
// download counter is touched. Any failure to authorize → uniform 404.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const rec = authorize(req, params.slug);
  if (!rec) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Remove the row first (atomic by slug) and learn the stored file id. If the
  // row is already gone (raced with cleanup/another delete) → uniform 404.
  const id = deleteFileBySlug(rec.slug);
  if (!id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Delete the blob. force:true means a missing file does not throw, so a share
  // whose blob was already burned/swept still reports a successful delete.
  await rm(join(UPLOADS_DIR, id), { force: true });

  return NextResponse.json({ ok: true });
}
