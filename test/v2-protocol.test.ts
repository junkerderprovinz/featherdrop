import { test, after } from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { ready, wrapKey } from "../lib/e2e/crypto";
import { serve, connect, type Client } from "../lib/e2e/v2/protocol";
import { cipherRange, type Header } from "../lib/e2e/v2/share";

// The handler runs on one end of a channel, the client on the other, as they
// would across a Web Worker boundary.
const channels: MessageChannel[] = [];
function pair(): Client {
  const ch = new MessageChannel();
  channels.push(ch);
  serve(ch.port1 as unknown as Parameters<typeof serve>[0]);
  return connect(ch.port2 as unknown as Parameters<typeof connect>[0]);
}
after(() => {
  for (const ch of channels) {
    ch.port1.close();
    ch.port2.close();
  }
});

function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 5 + seed) % 251);
}
const join = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

async function encryptVia(client: Client, data: Uint8Array, files: { name: string; type: string; size: number }[], password?: string) {
  const open = await client.request({ op: "encrypt-open", session: 1, files, password });
  const parts: Uint8Array[] = [open.prefix];
  for (let i = 0; i < data.length; i += 20_000) {
    const slice = data.slice(i, i + 20_000);
    const r = await client.request({ op: "encrypt-write", session: 1, data: slice }, [slice.buffer]);
    parts.push(...r.chunks);
  }
  for (;;) {
    const r = await client.request({ op: "encrypt-close", session: 1, maxBytes: 70_000 });
    parts.push(...r.chunks);
    if (r.done) break;
  }
  const blob = join(parts);
  assert.equal(blob.length, open.blobLength);
  return { blob, token: open.token, verifier: open.verifier };
}

async function decryptVia(client: Client, blob: Uint8Array, token: string, password?: string) {
  const { verifier } = await client.request({ op: "decrypt-open", session: 2, token, password });
  let header: Header | null = null;
  const out: Uint8Array[] = [];
  for (let i = 0; i < blob.length; i += 30_000) {
    const r = await client.request({ op: "decrypt-write", session: 2, data: blob.slice(i, i + 30_000) });
    if (r.header) {
      assert.equal(header, null, "the header arrives once");
      header = r.header;
    }
    out.push(...r.chunks);
  }
  await client.request({ op: "decrypt-close", session: 2 });
  return { verifier, header, plain: join(out) };
}

test("a bundle encrypts and decrypts through the worker protocol", async () => {
  const client = pair();
  const data = bytes(150_000);
  const files = [
    { name: "a", type: "", size: 100_000 },
    { name: "b", type: "", size: 50_000 },
  ];
  const enc = await encryptVia(client, data, files);
  const dec = await decryptVia(client, enc.blob, enc.token);
  assert.equal(dec.verifier, enc.verifier);
  assert.deepEqual(dec.header?.files, files);
  assert.deepEqual(dec.plain, data);
});

test("link and password mode works through the worker protocol", async () => {
  const client = pair();
  const data = bytes(1000);
  const files = [{ name: "a", type: "", size: 1000 }];
  const enc = await encryptVia(client, data, files, "correct horse battery");
  const dec = await decryptVia(client, enc.blob, enc.token, "correct horse battery");
  assert.deepEqual(dec.plain, data);
});

test("a wrong password gives a different verifier and an error, not plaintext", async () => {
  const client = pair();
  const files = [{ name: "a", type: "", size: 10 }];
  const enc = await encryptVia(client, bytes(10), files, "correct horse battery");
  await assert.rejects(decryptVia(client, enc.blob, enc.token, "wrong horse battery"), /header/);
  const { verifier } = await client.request({
    op: "decrypt-open",
    session: 3,
    token: enc.token,
    password: "wrong horse battery",
  });
  assert.notEqual(verifier, enc.verifier);
});

test("a seek decrypts the requested range from the fetched chunks", async () => {
  const client = pair();
  const size = 300_000;
  const data = bytes(size, 7);
  const enc = await encryptVia(client, data, [{ name: "v.mp4", type: "video/mp4", size }]);
  await client.request({ op: "decrypt-open", session: 4, token: enc.token });
  const prefixLen = 5 + new DataView(enc.blob.buffer).getUint32(1);
  const { header, contentOffset } = await client.request({
    op: "read-header",
    session: 4,
    data: enc.blob.slice(0, prefixLen),
  });
  const start = 140_000;
  const end = 150_000;
  const plan = cipherRange(header, contentOffset, start, end);
  assert.ok(plan);
  const { from, to } = plan;
  const r = await client.request({
    op: "range",
    session: 4,
    start,
    end,
    data: enc.blob.slice(from, to + 1),
  });
  assert.deepEqual(join(r.chunks), data.subarray(start, end + 1));
});

test("a seek before the worker opened the header is refused", async () => {
  const client = pair();
  const size = 10_000;
  const enc = await encryptVia(client, bytes(size), [{ name: "v.mp4", type: "video/mp4", size }]);
  await client.request({ op: "decrypt-open", session: 5, token: enc.token });

  await assert.rejects(
    client.request({ op: "range", session: 5, start: 0, end: 99, data: enc.blob.slice(0, 5000) }),
    /header/,
  );
});

test("an unknown session is an error", async () => {
  const client = pair();
  await assert.rejects(client.request({ op: "decrypt-write", session: 99, data: new Uint8Array(1) }), /session/);
});

test("an old password share unwraps in the worker", async () => {
  await ready();
  const key = new Uint8Array(32).fill(4);
  const { wrapped, salt } = wrapKey(key, "old password");
  const client = pair();
  const r = await client.request({ op: "unwrap", wrapped, salt, password: "old password" });
  assert.deepEqual(r.key, key);
  await assert.rejects(client.request({ op: "unwrap", wrapped, salt, password: "wrong" }));
});
