import { test } from "node:test";
import assert from "node:assert/strict";
import { zipStream, zipLength, zipEntryNames, type ZipEntry } from "../lib/e2e/zip";
import { readZip, readLargeZip, unzipTest } from "./zip-reader";

function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + seed) % 251);
}

async function* pieces(b: Uint8Array, size = 1000): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

function entries(files: { name: string; data: Uint8Array }[]): ZipEntry[] {
  return files.map((f) => ({ name: f.name, size: f.data.length, bytes: pieces(f.data) }));
}

async function collect(rs: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(rs).arrayBuffer());
}

test("a ZIP of several files reads back with standard unzip tools, names and sizes intact", async () => {
  const files = [
    { name: "Jahresbericht (final).pdf", data: bytes(70_000, 1) },
    { name: "leer.txt", data: new Uint8Array(0) },
    { name: "Ünïcödé 名前.bin", data: bytes(12_345, 2) },
  ];
  const zip = await collect(zipStream(entries(files)));

  const read = readZip(zip);
  assert.deepEqual(
    read.map((e) => [e.name, e.size, e.method]),
    files.map((f) => [f.name, f.data.length, 0]),
  );
  for (const [i, e] of read.entries()) assert.deepEqual(e.data, files[i].data);
  unzipTest(zip);
});

test("zipLength predicts the exact length of the ZIP", async () => {
  const files = [
    { name: "a.bin", data: bytes(100_000) },
    { name: "b.txt", data: bytes(3) },
  ];
  const zip = await collect(zipStream(entries(files)));
  assert.equal(zipLength(files.map((f) => ({ name: f.name, size: f.data.length }))), zip.length);
});

test("entry names cannot leave the folder they are unpacked into", () => {
  assert.deepEqual(zipEntryNames(["../../etc/passwd", "/abs", "a\\b", "..", ".", "", "ok.txt"]), [
    ".._.._etc_passwd",
    "_abs",
    "a_b",
    "_",
    "_ (2)",
    "_ (3)",
    "ok.txt",
  ]);
});

test("equal names in one bundle get a number before the extension", () => {
  assert.deepEqual(zipEntryNames(["a.txt", "a.txt", "b", "b", "a.txt", "a (2).txt"]), [
    "a.txt",
    "a (2).txt",
    "b",
    "b (2)",
    "a (3).txt",
    "a (2) (2).txt",
  ]);
});

test("the ZIP carries the safe names", async () => {
  const zip = await collect(
    zipStream([
      { name: "../x", size: 1, bytes: pieces(bytes(1)) },
      { name: "../x", size: 1, bytes: pieces(bytes(1)) },
    ]),
  );
  assert.deepEqual(
    readZip(zip).map((e) => e.name),
    [".._x", ".._x (2)"],
  );
});

test("an entry with fewer bytes than its declared size fails the stream", async () => {
  await assert.rejects(
    collect(zipStream([{ name: "a", size: 10, bytes: pieces(bytes(9)) }])),
    /zip: "a" has 9 bytes, expected 10/,
  );
});

test("an entry with more bytes than its declared size fails the stream", async () => {
  await assert.rejects(
    collect(zipStream([{ name: "a", size: 10, bytes: pieces(bytes(11)) }])),
    /zip: "a" has more than 10 bytes/,
  );
});

test("more than 65535 files make a ZIP64 archive that reads back whole", async () => {
  const n = 70_000;
  const one = bytes(1);
  const list: ZipEntry[] = Array.from({ length: n }, (_, i) => ({
    name: `f${i}`,
    size: 1,
    bytes: (async function* () {
      yield one;
    })(),
  }));
  const zip = await collect(zipStream(list));

  const read = readZip(zip, "list");
  assert.equal(read.length, n);
  assert.equal(read[n - 1].name, `f${n - 1}`);
  assert.equal(zip.length, zipLength(list));
});

test("a file past 4 GiB makes a ZIP64 archive whose sizes and offsets read back", { timeout: 120_000 }, async () => {
  const big = 4 * 1024 ** 3 + 1024 ** 2;
  const block = new Uint8Array(1024 ** 2);
  const after = bytes(5000, 3);
  async function* zeros() {
    for (let left = big; left > 0; left -= block.length) yield block;
  }
  const list: ZipEntry[] = [
    { name: "first.txt", size: 3, bytes: pieces(bytes(3)) },
    { name: "huge.bin", size: big, bytes: zeros() },
    { name: "after.txt", size: after.length, bytes: pieces(after) },
  ];
  const { size, entries: read } = await readLargeZip(zipStream(list));

  assert.equal(size, zipLength(list));
  assert.deepEqual(
    read.map((e) => [e.name, e.size]),
    [
      ["first.txt", 3],
      ["huge.bin", big],
      ["after.txt", after.length],
    ],
  );
  assert.ok(read[2].offset > 2 ** 32);
  assert.deepEqual(read[2].data, after);
});
