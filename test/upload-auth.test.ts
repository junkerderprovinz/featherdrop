import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// lib/config reads UPLOAD_PASSWORD at import time, so the value is fixed once
// per process. uploadTokenMatches needs no environment and runs here; each
// isUploadAuthorized scenario runs in a child process with its own environment.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** Runs isUploadAuthorized(<token>) in a fresh process with the given password. */
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
  // timingSafeEqual throws on unequal lengths.
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

test("isUploadAuthorized is open when UPLOAD_PASSWORD is unset", () => {
  assert.equal(authInChild(undefined, "undefined"), true, "no header → allowed");
  assert.equal(authInChild(undefined, '"anything"'), true, "any header → allowed");
  assert.equal(authInChild(undefined, '""'), true, "empty header → allowed");
});

test("isUploadAuthorized is open when UPLOAD_PASSWORD is empty", () => {
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
  // Node delivers a repeated header as string[].
  assert.equal(authInChild("topsecret", '["topsecret"]'), false);
  assert.equal(authInChild("topsecret", '["topsecret","topsecret"]'), false);
});
