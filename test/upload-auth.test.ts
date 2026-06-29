import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// lib/upload-auth imports lib/config, which reads UPLOAD_PASSWORD from
// process.env at IMPORT time. The env value therefore binds to the module graph
// once per process and can't be toggled by a query-string cache-bust (the bust
// would not re-evaluate the statically-imported config). So:
//   - the constant-time helper `uploadTokenMatches` is pure (no env) → tested
//     directly in this process;
//   - the env-driven gate `isUploadAuthorized` is exercised in a child process
//     per scenario, with UPLOAD_PASSWORD set/unset before import. This mirrors
//     the env-before-import pattern used by finalize-route.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/**
 * Evaluate `isUploadAuthorized(<token>)` in a fresh process with a given
 * UPLOAD_PASSWORD env, returning the boolean it produced.
 */
function authInChild(
  uploadPassword: string | undefined,
  tokenLiteral: string,
): boolean {
  const modUrl = pathToFileURL(join(repo, "lib/upload-auth.ts")).href;
  const code =
    `import { isUploadAuthorized } from ${JSON.stringify(modUrl)};` +
    `process.stdout.write(String(isUploadAuthorized(${tokenLiteral})));`;
  const env = { ...process.env };
  if (uploadPassword === undefined) delete env.UPLOAD_PASSWORD;
  else env.UPLOAD_PASSWORD = uploadPassword;
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { env, cwd: repo, encoding: "utf8" },
  );
  return out.trim() === "true";
}

// ---------------------------------------------------------------------------
// uploadTokenMatches — the constant-time comparison (pure, env-independent)
// ---------------------------------------------------------------------------

const { uploadTokenMatches, UPLOAD_TOKEN_HEADER } = await import(
  "../lib/upload-auth"
);

test("uploadTokenMatches accepts the exact secret", () => {
  assert.equal(uploadTokenMatches("s3cret", "s3cret"), true);
});

test("uploadTokenMatches rejects a same-length different value", () => {
  assert.equal(uploadTokenMatches("aaaaaa", "bbbbbb"), false);
});

test("uploadTokenMatches rejects on length mismatch without throwing", () => {
  // timingSafeEqual throws on unequal lengths; the helper must burn a dummy
  // comparison and return false (no exception, no early length shortcut).
  assert.equal(uploadTokenMatches("", "secret"), false);
  assert.equal(uploadTokenMatches("se", "secret"), false);
  assert.equal(uploadTokenMatches("secretsecret", "secret"), false);
});

test("uploadTokenMatches rejects a single-character difference", () => {
  assert.equal(uploadTokenMatches("secrXt", "secret"), false);
});

test("UPLOAD_TOKEN_HEADER is the documented header name", () => {
  assert.equal(UPLOAD_TOKEN_HEADER, "x-fd-upload-token");
});

// ---------------------------------------------------------------------------
// isUploadAuthorized — the request gate (env-driven, per-process)
// ---------------------------------------------------------------------------

test("isUploadAuthorized is OPEN when UPLOAD_PASSWORD is unset (no regression)", () => {
  assert.equal(authInChild(undefined, "undefined"), true, "no header → allowed");
  assert.equal(authInChild(undefined, '"anything"'), true, "any header → allowed");
  assert.equal(authInChild(undefined, '""'), true, "empty header → allowed");
});

test("isUploadAuthorized is OPEN when UPLOAD_PASSWORD is empty string", () => {
  assert.equal(authInChild("", "undefined"), true);
  assert.equal(authInChild("", '"whatever"'), true);
});

test("isUploadAuthorized requires the matching token when protected", () => {
  assert.equal(authInChild("topsecret", '"topsecret"'), true, "correct → allowed");
  assert.equal(authInChild("topsecret", '"wrong"'), false, "wrong → denied");
  assert.equal(authInChild("topsecret", "undefined"), false, "absent → denied");
  assert.equal(authInChild("topsecret", '""'), false, "empty → denied");
});

test("isUploadAuthorized rejects array header values when protected", () => {
  // Node can deliver a repeated header as string[]; only a single matching
  // string may pass.
  assert.equal(authInChild("topsecret", '["topsecret"]'), false);
  assert.equal(authInChild("topsecret", '["topsecret","topsecret"]'), false);
});
