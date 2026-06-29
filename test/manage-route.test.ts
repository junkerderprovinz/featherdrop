import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point DATA_DIR/CONFIG_DIR at throw-away temp dirs BEFORE any module that
// reads lib/config (config reads them at import time via top-level process.env).
const testDataDir = mkdtempSync(join(tmpdir(), "fd-mng-rt-"));
const testUploadsDir = join(testDataDir, "uploads");
const testTmpDir = join(testDataDir, "tmp");
mkdirSync(testUploadsDir, { recursive: true });
mkdirSync(testTmpDir, { recursive: true });

process.env.DATA_DIR = testDataDir;
process.env.CONFIG_DIR = testDataDir;
process.env.ENCRYPT_UPLOADS = "false";

// better-sqlite3 is a native addon; skip when it is not built locally.
let dbReason: string | boolean = false;
try {
  const Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  dbReason = "better-sqlite3 native addon not built";
}

type RouteModule = typeof import("../app/api/m/[slug]/route");
let routeMod: RouteModule | undefined;
type DbModule = typeof import("../server/db");
let db: DbModule | undefined;

if (!dbReason) {
  routeMod = await import("../app/api/m/[slug]/route");
  db = await import("../server/db");
  db.initDb();
}

import { NextRequest } from "next/server";
import { hashManageToken, newManageToken } from "../lib/manage-token";

let counter = 0;

/** Seed a v2 record with a blob and (optionally) a manage token. */
function seed(opts: {
  manageTokenHash?: string | null;
  expiresAt?: number | null;
}): { slug: string; id: string } {
  const id = `mng-${++counter}`;
  const slug = `slug-${id}`;
  writeFileSync(join(testUploadsDir, id), Buffer.from("blob bytes"));
  db!.createFileRecord({
    id,
    slug,
    original_name: "",
    size: 10,
    mime: null,
    password_hash: null,
    expires_at: opts.expiresAt ?? null,
    created_at: Date.now(),
    max_downloads: null,
    encrypted: 0,
    enc_mode: null,
    enc_key_wrapped: null,
    format: 2,
    wrapped_key: null,
    kdf_salt: null,
    key_verifier: null,
    manage_token_hash: opts.manageTokenHash ?? null,
  });
  return { slug, id };
}

function req(slug: string, token?: string, method = "DELETE"): NextRequest {
  return new NextRequest(`http://localhost/api/m/${slug}`, {
    method,
    headers: token ? { "x-fd-manage-token": token } : {},
  });
}

// ---------------------------------------------------------------------------
// DELETE — happy path
// ---------------------------------------------------------------------------

test(
  "DELETE with the right token removes the row AND the blob, returns 200",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const { slug, id } = seed({ manageTokenHash: hashManageToken(token) });
    assert.ok(existsSync(join(testUploadsDir, id)), "blob exists before delete");

    const res = await routeMod!.DELETE(req(slug, token), { params: { slug } });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.ok, true);

    assert.equal(db!.getFileBySlug(slug), undefined, "DB row must be gone");
    assert.equal(
      existsSync(join(testUploadsDir, id)),
      false,
      "blob must be deleted from disk",
    );
  },
);

// ---------------------------------------------------------------------------
// DELETE — uniform 404 on every unauthorized case (no info leak)
// ---------------------------------------------------------------------------

test(
  "DELETE with a wrong token returns 404 and does NOT delete",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const { slug, id } = seed({ manageTokenHash: hashManageToken(token) });

    const res = await routeMod!.DELETE(req(slug, newManageToken()), {
      params: { slug },
    });
    assert.equal(res.status, 404, "wrong token → uniform 404");
    assert.ok(db!.getFileBySlug(slug), "row must survive a wrong token");
    assert.ok(existsSync(join(testUploadsDir, id)), "blob must survive");
  },
);

test(
  "DELETE with no token header returns 404",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const { slug } = seed({ manageTokenHash: hashManageToken(token) });
    const res = await routeMod!.DELETE(req(slug), { params: { slug } });
    assert.equal(res.status, 404);
    assert.ok(db!.getFileBySlug(slug), "row must survive a missing token");
  },
);

test(
  "DELETE on a legacy share (manage_token_hash NULL) returns 404",
  { skip: dbReason },
  async () => {
    const { slug } = seed({ manageTokenHash: null });
    // Even with SOME token, a legacy null-hash share is never manageable.
    const res = await routeMod!.DELETE(req(slug, newManageToken()), {
      params: { slug },
    });
    assert.equal(res.status, 404, "legacy share → uniform 404");
    assert.ok(db!.getFileBySlug(slug), "legacy row must survive");
  },
);

test(
  "DELETE on an unknown slug returns 404",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const res = await routeMod!.DELETE(req("does-not-exist", token), {
      params: { slug: "does-not-exist" },
    });
    assert.equal(res.status, 404);
  },
);

test(
  "DELETE on an expired share returns 404 (treated as gone)",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const { slug } = seed({
      manageTokenHash: hashManageToken(token),
      expiresAt: Date.now() - 1000,
    });
    const res = await routeMod!.DELETE(req(slug, token), { params: { slug } });
    assert.equal(res.status, 404);
  },
);

// ---------------------------------------------------------------------------
// GET — token-gated status, never counts a download
// ---------------------------------------------------------------------------

test(
  "GET with the right token returns the share status",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const { slug } = seed({ manageTokenHash: hashManageToken(token) });
    const res = await routeMod!.GET(req(slug, token, "GET"), {
      params: { slug },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.ok, true);
    assert.equal(json.size, 10);
    // GET must not register a download (no counter side effect).
    const row = db!.getFileBySlug(slug);
    assert.equal(row?.download_count, 0, "GET must not count a download");
  },
);

test(
  "GET with a wrong/absent token returns 404",
  { skip: dbReason },
  async () => {
    const token = newManageToken();
    const { slug } = seed({ manageTokenHash: hashManageToken(token) });
    const wrong = await routeMod!.GET(req(slug, newManageToken(), "GET"), {
      params: { slug },
    });
    assert.equal(wrong.status, 404);
    const none = await routeMod!.GET(req(slug, undefined, "GET"), {
      params: { slug },
    });
    assert.equal(none.status, 404);
  },
);
