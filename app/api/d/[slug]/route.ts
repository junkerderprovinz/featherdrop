import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MASTER_KEY, UPLOADS_DIR } from "@/lib/config";
import {
  getFileBySlug,
  registerDownload,
  type FileRecord,
} from "@/server/db";
import { verifyPassword } from "@/lib/password";
import { downloadToken, tokenMatches } from "@/lib/token";
import { decryptStream, unwrapKey } from "@/server/crypto";

export const runtime = "nodejs";

// Short-lived cookie that authorizes the streaming GET. For encrypted shares it
// carries the per-file age key (a leak exposes only this one file — by design,
// the same exposure as the link fragment); for legacy plaintext+password shares
// it carries a non-empty marker. httpOnly + sameSite=strict + path-scoped.
const COOKIE = "fd_key";

interface AuthBody {
  password?: string;
  key?: string; // link-key from the share URL fragment (link mode)
}

function isExpired(rec: FileRecord, now = Date.now()): boolean {
  return rec.expires_at !== null && rec.expires_at <= now;
}

// RFC 5987 filename so non-ASCII names survive the Content-Disposition header.
// `inline` renders the file in the browser (preview) instead of downloading it.
function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(name);
  const kind = inline ? "inline" : "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function fileStream(id: string, deleteAfter = false): ReadableStream<Uint8Array> {
  const path = join(UPLOADS_DIR, id);
  const rs = createReadStream(path);
  if (deleteAfter) {
    // Burn-after-download: remove the blob once it has been fully read/streamed.
    rs.on("close", () => void rm(path, { force: true }));
  }
  return Readable.toWeb(rs) as ReadableStream<Uint8Array>;
}

// Resolve the per-file age key for an encrypted record:
//   - link:     from the link key the client read out of the URL fragment.
//   - password: unwrap with the verified password.
//   - server:   unwrap with the server master key — no client credential needed.
// Returns null when the credential is missing/wrong or the master key is absent.
async function resolveKey(
  rec: FileRecord,
  cred: AuthBody,
): Promise<string | null> {
  if (rec.enc_mode === "link") {
    return cred.key ? cred.key : null;
  }
  if (rec.enc_mode === "password") {
    const password = cred.password ?? "";
    if (!rec.password_hash || !verifyPassword(password, rec.password_hash)) {
      return null;
    }
    try {
      return await unwrapKey(rec.enc_key_wrapped ?? "", password);
    } catch {
      return null;
    }
  }
  if (rec.enc_mode === "server") {
    if (!MASTER_KEY) return null; // master key removed → cannot decrypt
    try {
      return await unwrapKey(rec.enc_key_wrapped ?? "", MASTER_KEY);
    } catch {
      return null;
    }
  }
  return null;
}

// GET streams the file, decrypting on the fly for encrypted shares. The cookie
// set by a successful POST below authorizes it (and carries the key).
export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<Response> {
  const rec = getFileBySlug(params.slug);
  if (!rec || isExpired(rec)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    await stat(join(UPLOADS_DIR, rec.id));
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const cookie = req.cookies.get(COOKIE)?.value;

  // Preview mode (?inline=1): render the file in the browser without counting a
  // download. Allowed ONLY for unlimited shares — otherwise a preview would
  // bypass the download limit (a limited share falls through to a real download).
  const wantInline =
    req.nextUrl.searchParams.get("inline") === "1" && rec.max_downloads === null;

  // Plaintext blob (legacy): the password gate requires the cookie to carry the
  // unforgeable, hash-derived download token — not merely be present, or anyone
  // with the public slug could send any value and bypass the password.
  if (!rec.encrypted) {
    if (rec.password_hash && !tokenMatches(cookie, rec.password_hash)) {
      return NextResponse.json({ error: "password required" }, { status: 403 });
    }
    if (wantInline) {
      return new Response(fileStream(rec.id), {
        headers: {
          "Content-Type": rec.mime ?? "application/octet-stream",
          "Content-Length": String(rec.size),
          "Content-Disposition": contentDisposition(rec.original_name, true),
          "Cache-Control": "private, no-store",
        },
      });
    }
    const dl = registerDownload(rec.slug);
    if (!dl.allowed) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return new Response(fileStream(rec.id, dl.burned), {
      headers: {
        "Content-Type": rec.mime ?? "application/octet-stream",
        "Content-Length": String(rec.size),
        "Content-Disposition": contentDisposition(rec.original_name),
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (!cookie) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  // Decrypt the header first to prove the cookie's key is valid, THEN count the
  // download — so a bogus cookie can't burn through a limited share's downloads.
  const path = join(UPLOADS_DIR, rec.id);
  const rs = createReadStream(path);
  let header: { name: string; mime: string | null };
  let plaintext: ReadableStream<Uint8Array>;
  try {
    const out = await decryptStream(
      Readable.toWeb(rs) as ReadableStream<Uint8Array>,
      cookie,
    );
    header = out.header;
    plaintext = out.plaintext;
  } catch {
    rs.destroy();
    return NextResponse.json({ error: "could not decrypt" }, { status: 401 });
  }

  if (wantInline) {
    // Preview an unlimited encrypted share: stream decrypted, inline, no count.
    return new Response(plaintext, {
      headers: {
        "Content-Type": header.mime ?? "application/octet-stream",
        "Content-Disposition": contentDisposition(header.name, true),
        "Cache-Control": "private, no-store",
      },
    });
  }

  const dl = registerDownload(rec.slug);
  if (!dl.allowed) {
    rs.destroy();
    await plaintext.cancel();
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Burn-after-download: remove the blob once the stream has been fully read.
  if (dl.burned) rs.on("close", () => void rm(path, { force: true }));

  // No Content-Length: we stream the decrypted bytes without buffering and the
  // plaintext length differs from the on-disk ciphertext size.
  return new Response(plaintext, {
    headers: {
      "Content-Type": header.mime ?? "application/octet-stream",
      "Content-Disposition": contentDisposition(header.name),
      "Cache-Control": "private, no-store",
    },
  });
}

// POST authorizes a download: it validates the credential (password or link
// key), and on success sets the short-lived cookie and returns the real
// filename (decrypted from the file header) so the page can show it. The client
// then triggers the GET to stream the file natively.
export async function POST(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const rec = getFileBySlug(params.slug);
  if (!rec || isExpired(rec)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let cred: AuthBody = {};
  try {
    const text = await req.text();
    if (text) cred = JSON.parse(text) as AuthBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const setCookie = (res: NextResponse, value: string) =>
    res.cookies.set(COOKIE, value, {
      path: `/api/d/${rec.slug}`,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 300,
    });

  // Plaintext blob (legacy): verify password if set, then authorize the GET with
  // the hash-derived token (NOT a bare marker — see tokenMatches).
  if (!rec.encrypted) {
    if (rec.password_hash) {
      if (!verifyPassword(cred.password ?? "", rec.password_hash)) {
        return NextResponse.json({ error: "wrong password" }, { status: 401 });
      }
    }
    const res = NextResponse.json({
      ok: true,
      name: rec.original_name,
      mime: rec.mime,
    });
    if (rec.password_hash) setCookie(res, downloadToken(rec.password_hash));
    return res;
  }

  const key = await resolveKey(rec, cred);
  if (!key) {
    const status = rec.enc_mode === "password" ? 401 : 422;
    return NextResponse.json(
      {
        error:
          rec.enc_mode === "password" ? "wrong password" : "key required",
      },
      { status },
    );
  }

  // Decrypt just the header to learn the filename + type (and confirm the key
  // works) before authorizing the stream.
  let name: string;
  let mime: string | null;
  try {
    const out = await decryptStream(fileStream(rec.id), key);
    name = out.header.name;
    mime = out.header.mime;
    await out.plaintext.cancel();
  } catch {
    return NextResponse.json({ error: "could not decrypt" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, name, mime });
  setCookie(res, key);
  return res;
}
