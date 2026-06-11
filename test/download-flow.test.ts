import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, computeKeyVerifier, decodeKey } from "../lib/e2e/crypto";
import { encryptForUpload } from "../lib/e2e/pipeline";
import { downloadDecrypted } from "../lib/e2e/download-flow";

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
  return new Uint8Array(n).map((_, i) => (i * 13 + 7) % 251);
}
function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}
async function collectStream(rs: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = rs.getReader();
  const parts: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    len += value.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const META = { name: "report.pdf", type: "application/pdf" };

test("downloadDecrypted hands fetchBlob the verifier of the link key", async () => {
  const data = bytes(3000);
  const { blob, keyForUrl } = await encryptForUpload(one(data), META);
  const cipher = await collect(blob);

  let seenVerifier: string | undefined;
  let saved: Uint8Array | undefined;
  const { meta } = await downloadDecrypted(
    (keyVerifier) => {
      seenVerifier = keyVerifier;
      return Promise.resolve(streamOf(cipher));
    },
    { keyFromUrl: keyForUrl },
    async (plaintext) => {
      saved = await collectStream(plaintext);
    },
  );

  assert.equal(seenVerifier, computeKeyVerifier(decodeKey(keyForUrl)));
  assert.deepEqual(meta, META);
  assert.deepEqual(saved, data);
});

test("downloadDecrypted (password mode) sends the same verifier the upload stored", async () => {
  const data = bytes(2000);
  const { blob, wrapped, keyVerifier } = await encryptForUpload(one(data), META, {
    password: "pw",
  });
  const cipher = await collect(blob);

  let seenVerifier: string | undefined;
  await downloadDecrypted(
    (v) => {
      seenVerifier = v;
      return Promise.resolve(streamOf(cipher));
    },
    { password: "pw", wrapped: wrapped!.wrapped, salt: wrapped!.salt },
    async (plaintext) => {
      await collectStream(plaintext);
    },
  );

  // The downloader's proof must equal what finalize stored — or the server's
  // constant-time compare would 401 the request.
  assert.equal(seenVerifier, keyVerifier);
});

test("a wrong password rejects BEFORE fetchBlob is ever called", async () => {
  const { blob, wrapped } = await encryptForUpload(one(bytes(500)), META, {
    password: "right",
  });
  const cipher = await collect(blob);

  let fetched = false;
  await assert.rejects(() =>
    downloadDecrypted(
      () => {
        fetched = true;
        return Promise.resolve(streamOf(cipher));
      },
      { password: "wrong", wrapped: wrapped!.wrapped, salt: wrapped!.salt },
      async () => {},
    ),
  );
  // No request means nothing the server could have counted or burned.
  assert.equal(fetched, false, "wrong password must never reach the network");
});
