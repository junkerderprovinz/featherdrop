import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadEncrypted, type FinalizeRequest } from "../lib/e2e/upload-flow";
import { hashManageToken, manageTokenFromFragment } from "../lib/e2e/manage-link";

test("uploadEncrypted sends only the manage token's hash and returns the management link", async () => {
  let sent: FinalizeRequest | undefined;
  const { shareUrl, manageUrl } = await uploadEncrypted(
    [new File([new Uint8Array(64).fill(3)], "a.bin", { type: "application/octet-stream" })],
    { expiry: "1d", maxDownloads: 1 },
    {
      upload: () => Promise.resolve("upload-id"),
      finalize: (body) => {
        sent = body;
        return Promise.resolve({ slug: "k7Mx9qT2" });
      },
      baseUrl: "https://drop.example.tld",
    },
  );

  assert.match(shareUrl, /^https:\/\/drop\.example\.tld\/d\/k7Mx9qT2#k=/);
  const prefix = "https://drop.example.tld/m/k7Mx9qT2#t=";
  assert.ok(manageUrl.startsWith(prefix), manageUrl);
  const token = manageTokenFromFragment(manageUrl.slice(manageUrl.indexOf("#")));
  assert.ok(sent);
  assert.equal(sent.manageTokenHash, await hashManageToken(token));
  assert.ok(!JSON.stringify(sent).includes(token), "the raw token must not reach the server");
});
