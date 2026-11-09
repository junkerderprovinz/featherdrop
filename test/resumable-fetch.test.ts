import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchResumable, RESUME_TOKEN_HEADER } from "../lib/e2e/resumable-fetch";

const TOKEN = "t".repeat(43);

function blob(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 31 + 5) % 251);
}

// A body that hands out data in 100-byte pieces and fails with a network
// error once breakAt bytes have gone out.
function body(data: Uint8Array, breakAt = Infinity): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= data.length) {
        controller.close();
        return;
      }
      if (sent >= breakAt) {
        controller.error(new TypeError("network error"));
        return;
      }
      const end = Math.min(sent + 100, data.length, breakAt);
      controller.enqueue(data.slice(sent, end));
      sent = end;
    },
  });
}

type Answer = (offset: number, headers: Headers) => Response | Promise<Response>;

// A fake server: the first request gets answers[0], each resume the next one.
// It records every request's headers.
function server(data: Uint8Array, answers: Answer[]) {
  const seen: Headers[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push(headers);
    const answer = answers[seen.length - 1];
    if (!answer) throw new Error("unexpected request");
    const m = /^bytes=(\d+)-$/.exec(headers.get("range") ?? "");
    return answer(m ? Number(m[1]) : 0, headers);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function counted(data: Uint8Array, breakAt?: number): Answer {
  return () =>
    new Response(body(data, breakAt), {
      status: 200,
      headers: { [RESUME_TOKEN_HEADER]: TOKEN, "content-length": String(data.length) },
    });
}

function partial(data: Uint8Array, breakAt?: number): Answer {
  return (offset) =>
    new Response(body(data.slice(offset), breakAt), {
      status: 206,
      headers: {
        "content-range": `bytes ${offset}-${data.length - 1}/${data.length}`,
        "content-length": String(data.length - offset),
      },
    });
}

const noWait = { sleep: async () => {} };

async function read(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

test("an unbroken download is passed through with one request", async () => {
  const data = blob(1000);
  const { fetchImpl, seen } = server(data, [counted(data)]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  assert.deepEqual(await read(res), data);
  assert.equal(seen.length, 1);
});

test("a broken download continues with Range and the token", async () => {
  const data = blob(1000);
  const { fetchImpl, seen } = server(data, [counted(data, 300), partial(data)]);

  const res = await fetchResumable(
    "/api/d/x",
    { headers: { "x-fd-key-verifier": "v" } },
    { fetchImpl, ...noWait },
  );

  assert.deepEqual(await read(res), data);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].get(RESUME_TOKEN_HEADER), null);
  assert.equal(seen[1].get(RESUME_TOKEN_HEADER), TOKEN);
  assert.equal(seen[1].get("range"), "bytes=300-");
  assert.equal(seen[1].get("x-fd-key-verifier"), "v");
});

test("a download that breaks several times still arrives whole", async () => {
  const data = blob(1000);
  const { fetchImpl, seen } = server(data, [
    counted(data, 200),
    partial(data, 300),
    partial(data, 100),
    partial(data),
  ]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  assert.deepEqual(await read(res), data);
  assert.deepEqual(
    seen.slice(1).map((h) => h.get("range")),
    ["bytes=200-", "bytes=500-", "bytes=600-"],
  );
});

test("a body that ends short is resumed", async () => {
  const data = blob(1000);
  const short: Answer = () =>
    new Response(body(data.slice(0, 400)), {
      status: 200,
      headers: { [RESUME_TOKEN_HEADER]: TOKEN, "content-length": "1000" },
    });
  const { fetchImpl } = server(data, [short, partial(data)]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  assert.deepEqual(await read(res), data);
});

test("network errors while resuming are retried with growing delays", async () => {
  const data = blob(1000);
  const down: Answer = () => {
    throw new TypeError("network error");
  };
  const { fetchImpl } = server(data, [counted(data, 500), down, down, partial(data)]);
  const delays: number[] = [];

  const res = await fetchResumable("/api/d/x", {}, {
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  assert.deepEqual(await read(res), data);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test("the stream fails once the retries run out", async () => {
  const data = blob(1000);
  const down: Answer = () => {
    throw new TypeError("network error");
  };
  const { fetchImpl, seen } = server(data, [counted(data, 500), down, down, down]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, retries: 3, ...noWait });

  await assert.rejects(read(res));
  assert.equal(seen.length, 4);
});

test("a refused resume fails the stream without further tries", async () => {
  const data = blob(1000);
  const gone: Answer = () => new Response('{"error":"not found"}', { status: 404 });
  const { fetchImpl, seen } = server(data, [counted(data, 500), gone]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  await assert.rejects(read(res), /resume 404/);
  assert.equal(seen.length, 2);
});

test("a resume that starts at the wrong offset is refused", async () => {
  const data = blob(1000);
  const wrong: Answer = () =>
    new Response(body(data), {
      status: 206,
      headers: { "content-range": `bytes 0-999/1000` },
    });
  const { fetchImpl } = server(data, [counted(data, 500), wrong]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  await assert.rejects(read(res));
});

test("a refused first request is returned as it is", async () => {
  const data = blob(10);
  const busy: Answer = () => new Response('{"error":"download in progress"}', { status: 409 });
  const { fetchImpl } = server(data, [busy]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  assert.equal(res.status, 409);
});

test("a response without a token is not resumed", async () => {
  const data = blob(1000);
  const plain: Answer = () => new Response(body(data, 500), { status: 200 });
  const { fetchImpl, seen } = server(data, [plain]);

  const res = await fetchResumable("/api/d/x", {}, { fetchImpl, ...noWait });

  await assert.rejects(read(res));
  assert.equal(seen.length, 1);
});
