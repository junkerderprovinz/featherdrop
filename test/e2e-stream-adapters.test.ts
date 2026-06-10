// Unit tests for lib/e2e/stream-adapters.ts.
// Uses node:test + the Node.js 18+ ReadableStream implementation — no browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  streamToAsyncIterable,
  asyncIterableToStream,
} from "../lib/e2e/stream-adapters";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build an AsyncIterable that yields the provided arrays one at a time. */
async function* fromChunks(
  chunks: Uint8Array[],
): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

/** Collect all chunks from an AsyncIterable into one flat Uint8Array. */
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let len = 0;
  for await (const c of it) {
    parts.push(c);
    len += c.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Collect all bytes from a ReadableStream. */
async function collectStream(rs: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return collect(streamToAsyncIterable(rs));
}

/** Build a ReadableStream from the provided chunks. */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[i++]);
    },
  });
}

function pattern(n: number, seed = 0): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (seed + i) % 251;
  return a;
}

// ── streamToAsyncIterable ────────────────────────────────────────────────────

test("streamToAsyncIterable: single chunk round-trip", async () => {
  const data = pattern(1024);
  const rs = streamFromChunks([data]);
  const got = await collect(streamToAsyncIterable(rs));
  assert.deepEqual(got, data);
});

test("streamToAsyncIterable: empty stream yields nothing", async () => {
  const rs = streamFromChunks([]);
  const got = await collect(streamToAsyncIterable(rs));
  assert.equal(got.length, 0);
});

test("streamToAsyncIterable: multiple chunks preserve content", async () => {
  const chunks = [pattern(64, 0), pattern(128, 1), pattern(32, 2)];
  const expected = await collect(fromChunks(chunks));
  const rs = streamFromChunks(chunks);
  const got = await collect(streamToAsyncIterable(rs));
  assert.deepEqual(got, expected);
});

test("streamToAsyncIterable: large 2 MiB stream", async () => {
  const CHUNK = 64 * 1024;
  const FRAMES = 32;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < FRAMES; i++) chunks.push(pattern(CHUNK, i));
  const expected = await collect(fromChunks(chunks));
  const got = await collect(streamToAsyncIterable(streamFromChunks(chunks)));
  assert.deepEqual(got, expected);
});

// ── asyncIterableToStream ────────────────────────────────────────────────────

test("asyncIterableToStream: single chunk round-trip", async () => {
  const data = pattern(1024, 7);
  const it = fromChunks([data]);
  const got = await collectStream(asyncIterableToStream(it));
  assert.deepEqual(got, data);
});

test("asyncIterableToStream: empty iterable yields empty stream", async () => {
  const it = fromChunks([]);
  const got = await collectStream(asyncIterableToStream(it));
  assert.equal(got.length, 0);
});

test("asyncIterableToStream: multiple chunks preserve content", async () => {
  const chunks = [pattern(100, 3), pattern(200, 5), pattern(50, 9)];
  const expected = await collect(fromChunks(chunks));
  const got = await collectStream(asyncIterableToStream(fromChunks(chunks)));
  assert.deepEqual(got, expected);
});

test("asyncIterableToStream: large 2 MiB iterable", async () => {
  const CHUNK = 64 * 1024;
  const FRAMES = 32;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < FRAMES; i++) chunks.push(pattern(CHUNK, i * 3));
  const expected = await collect(fromChunks(chunks));
  const got = await collectStream(asyncIterableToStream(fromChunks(chunks)));
  assert.deepEqual(got, expected);
});

// ── round-trip: AsyncIterable → Stream → AsyncIterable ───────────────────────

test("round-trip iterable→stream→iterable preserves data", async () => {
  const chunks = [pattern(300, 0), pattern(700, 1), pattern(1024, 2)];
  const original = await collect(fromChunks(chunks));
  const stream = asyncIterableToStream(fromChunks(chunks));
  const got = await collect(streamToAsyncIterable(stream));
  assert.deepEqual(got, original);
});

// ── round-trip: Stream → AsyncIterable → Stream ───────────────────────────────

test("round-trip stream→iterable→stream preserves data", async () => {
  const chunks = [pattern(512, 4), pattern(512, 8)];
  const expected = await collect(fromChunks(chunks));
  const rs = streamFromChunks(chunks);
  const it = streamToAsyncIterable(rs);
  const rs2 = asyncIterableToStream(it);
  const got = await collectStream(rs2);
  assert.deepEqual(got, expected);
});
