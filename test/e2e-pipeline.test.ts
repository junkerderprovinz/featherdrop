import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, PT_CHUNK } from "../lib/e2e/crypto";
import { encryptForUpload, decryptFromDownload } from "../lib/e2e/pipeline";

before(async () => {
  await ready();
});

async function* one(b: Uint8Array) {
  yield b;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let len = 0;
  for await (const p of it) {
    parts.push(p);
    len += p.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function bytes(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 11 + 5) % 251);
}

const META = { name: "Jahresbericht (final).pdf", type: "application/pdf" };

for (const size of [0, 1000, PT_CHUNK, PT_CHUNK * 3 + 17]) {
  test(`link mode round-trips end-to-end at ${size} bytes`, async () => {
    const data = bytes(size);
    const { blob, keyForUrl, wrapped } = await encryptForUpload(one(data), META);
    assert.equal(wrapped, undefined);
    assert.match(keyForUrl, /^[A-Za-z0-9_-]+$/);
    const cipher = await collect(blob);
    const { meta, plaintext } = await decryptFromDownload(one(cipher), {
      keyFromUrl: keyForUrl,
    });
    assert.deepEqual(meta, META);
    assert.deepEqual(await collect(plaintext), data);
  });
}

test("password mode round-trips end-to-end (no key in the link)", async () => {
  const data = bytes(5000);
  const { blob, keyForUrl, wrapped } = await encryptForUpload(one(data), META, {
    password: "correct horse battery staple",
  });
  assert.equal(keyForUrl, "");
  assert.ok(wrapped);
  const cipher = await collect(blob);
  const { meta, plaintext } = await decryptFromDownload(one(cipher), {
    password: "correct horse battery staple",
    wrapped: wrapped!.wrapped,
    salt: wrapped!.salt,
  });
  assert.deepEqual(meta, META);
  assert.deepEqual(await collect(plaintext), data);
});

test("a wrong URL key fails to decrypt", async () => {
  const { blob } = await encryptForUpload(one(bytes(2000)), META);
  const cipher = await collect(blob);
  // a valid-shape but wrong key (32 random bytes, base64url)
  const wrong = await encryptForUpload(one(bytes(1)), META);
  await assert.rejects(() =>
    decryptFromDownload(one(cipher), { keyFromUrl: wrong.keyForUrl }),
  );
});

test("a wrong password fails to decrypt", async () => {
  const { blob, wrapped } = await encryptForUpload(one(bytes(2000)), META, {
    password: "right",
  });
  const cipher = await collect(blob);
  await assert.rejects(() =>
    decryptFromDownload(one(cipher), {
      password: "wrong",
      wrapped: wrapped!.wrapped,
      salt: wrapped!.salt,
    }),
  );
});

test("the server-visible blob leaks neither the filename nor the content", async () => {
  const marker = "TOPSECRET_FEATHERDROP_PAYLOAD";
  const { blob } = await encryptForUpload(
    one(new TextEncoder().encode(marker)),
    { name: "my-secret-filename.txt", type: "text/plain" },
  );
  const hay = new TextDecoder("latin1").decode(await collect(blob));
  assert.ok(!hay.includes(marker), "content leaked");
  assert.ok(!hay.includes("my-secret-filename"), "filename leaked");
});
