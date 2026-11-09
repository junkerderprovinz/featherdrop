import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createManageToken,
  manageUrl,
  manageTokenFromFragment,
  revokeShare,
} from "../lib/e2e/manage-link";
import { cryptoWorker } from "./crypto-worker";

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

function sha256Base64Url(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

test("createManageToken returns a 32-byte base64url token and its SHA-256", async () => {
  const { token, hash } = await createManageToken(cryptoWorker());

  assert.match(token, BASE64URL_43);
  assert.equal(hash, sha256Base64Url(token));
});

test("createManageToken never repeats a token", async () => {
  const worker = cryptoWorker();
  const a = await createManageToken(worker);
  const b = await createManageToken(worker);

  assert.notEqual(a.token, b.token);
});

test("manageUrl puts the token in the fragment, out of the request path", () => {
  assert.equal(
    manageUrl("https://drop.example.tld", "k7Mx9qT2", "tok_en-43"),
    "https://drop.example.tld/m/k7Mx9qT2#t=tok_en-43",
  );
});

test("manageTokenFromFragment reads the token of a management link", () => {
  assert.equal(manageTokenFromFragment("#t=tok_en-43"), "tok_en-43");
  assert.equal(manageTokenFromFragment("#k=content-key"), "");
  assert.equal(manageTokenFromFragment(""), "");
});

function recordingFetch(status: number) {
  const calls: { url: string; method?: string; token: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      token: new Headers(init?.headers).get("x-fd-manage-token"),
    });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("revokeShare sends the token in a header to the delete route", async () => {
  const { calls, fetchImpl } = recordingFetch(204);

  assert.equal(await revokeShare("k7Mx9qT2", "secret-token", fetchImpl), "deleted");
  assert.deepEqual(calls, [
    { url: "/api/m/k7Mx9qT2", method: "DELETE", token: "secret-token" },
  ]);
});

test("revokeShare reports a share that is gone or a token that does not match", async () => {
  const { fetchImpl } = recordingFetch(404);

  assert.equal(await revokeShare("slug", "token", fetchImpl), "notfound");
});

test("revokeShare rejects on a server error", async () => {
  const { fetchImpl } = recordingFetch(500);

  await assert.rejects(revokeShare("slug", "token", fetchImpl), /500/);
});
