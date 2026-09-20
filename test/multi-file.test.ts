import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, PT_CHUNK, decodeKey } from "../lib/e2e/crypto";
import { fromBase64 } from "../lib/e2e/crypto";
import { peekBlobHeader } from "../lib/e2e/blob-layout";
import { decryptSeekableRange } from "../lib/e2e/seekable";
import {
  buildManifest,
  concatFiles,
  splitByManifest,
  type PackFile,
} from "../lib/e2e/multi-file";
import {
  encryptFilesForUpload,
  decryptFilesFromDownload,
  decryptFilesWithKey,
} from "../lib/e2e/multi-pipeline";
import {
  generateKey,
  encodeKey,
  encryptChunks,
  encryptManifest as encryptManifestRaw,
} from "../lib/e2e/crypto";
import { assembleBlob } from "../lib/e2e/blob-layout";

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
function bytes(n: number, seed = 0): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 7 + seed * 13 + 3) % 251);
}

/**
 * A PackFile that yields data in 40 KB pieces, which do not line up with
 * PT_CHUNK.
 */
function packFile(name: string, type: string, data: Uint8Array): PackFile {
  return {
    name,
    type,
    size: data.length,
    stream: async function* () {
      const piece = 40000;
      for (let i = 0; i < data.length; i += piece) {
        yield data.subarray(i, i + piece);
      }
    },
  };
}

// One file across several chunks, one empty and one of a single byte.
function sampleFiles(): { files: PackFile[]; data: Uint8Array[] } {
  const data = [
    bytes(PT_CHUNK * 2 + 123, 1),
    bytes(0, 2),
    bytes(1, 3),
  ];
  const files = [
    packFile("report.bin", "application/octet-stream", data[0]),
    packFile("empty.txt", "text/plain", data[1]),
    packFile("one.dat", "application/octet-stream", data[2]),
  ];
  return { files, data };
}

test("pure: concatFiles -> splitByManifest reassembles N files byte-exact", async () => {
  const { files, data } = sampleFiles();
  const manifest = buildManifest(files);

  assert.deepEqual(manifest.files, [
    { name: "report.bin", type: "application/octet-stream", size: data[0].length },
    { name: "empty.txt", type: "text/plain", size: 0 },
    { name: "one.dat", type: "application/octet-stream", size: 1 },
  ]);

  let idx = 0;
  for await (const { entry, bytes: fileBytes } of splitByManifest(
    concatFiles(files),
    manifest,
  )) {
    assert.deepEqual(entry, manifest.files[idx]);
    const got = await collect(fileBytes);
    assert.deepEqual(got, data[idx], `file ${idx} bytes`);
    idx++;
  }
  assert.equal(idx, files.length, "all files yielded");
});

test("pure: splitByManifest throws 'truncated' when the source ends early", async () => {
  const { files, data } = sampleFiles();
  const manifest = buildManifest(files);

  // Everything except the last file's final byte.
  const full = await collect(concatFiles(files));
  const short = full.subarray(0, full.length - 1);

  await assert.rejects(
    async () => {
      for await (const { bytes: fileBytes } of splitByManifest(one(short), manifest)) {
        await collect(fileBytes);
      }
    },
    /truncated/,
  );

  let total = 0;
  for await (const { bytes: fileBytes } of splitByManifest(one(full), manifest)) {
    total += (await collect(fileBytes)).length;
  }
  assert.equal(total, data.reduce((a, d) => a + d.length, 0));
});

test("pure: concatFiles throws when a file yields fewer bytes than its size", async () => {
  const f: PackFile = {
    name: "shrunk.bin",
    type: "application/octet-stream",
    size: 100,
    stream: async function* () {
      yield bytes(60, 5);
    },
  };
  await assert.rejects(
    async () => {
      for await (const _ of concatFiles([f])) void _;
    },
    /shrunk\.bin.*changed during upload.*expected 100 bytes, got 60/,
  );
});

test("pure: concatFiles throws when a file yields more bytes than its size", async () => {
  const f: PackFile = {
    name: "grown.bin",
    type: "application/octet-stream",
    size: 50,
    stream: async function* () {
      yield bytes(30, 6);
      yield bytes(50, 7);
    },
  };
  await assert.rejects(
    async () => {
      for await (const _ of concatFiles([f])) void _;
    },
    /grown\.bin.*grew during upload/,
  );
});

test("crypto: encrypt 3 files (link mode) -> decrypt -> byte-identical", async () => {
  const { files, data } = sampleFiles();
  const expectedManifest = buildManifest(files);

  const { blob, keyForUrl, wrapped, keyVerifier } = await encryptFilesForUpload(files);
  assert.equal(wrapped, undefined);
  assert.match(keyForUrl, /^[A-Za-z0-9_-]+$/);
  assert.match(keyVerifier, /^[A-Za-z0-9_-]{43}$/);

  const cipher = await collect(blob);
  const { manifest, files: out } = await decryptFilesFromDownload(one(cipher), {
    keyFromUrl: keyForUrl,
  });
  assert.deepEqual(manifest.files, expectedManifest.files);
  assert.equal(manifest.cf, 2, "new multi-file uploads must be cf=2 (seekable)");
  assert.equal(manifest.chunkSize, PT_CHUNK);
  assert.equal(typeof manifest.baseNonce, "string");
  assert.equal(
    manifest.size,
    data.reduce((a, d) => a + d.length, 0),
    "manifest.size = total concatenated plaintext length",
  );

  let idx = 0;
  for await (const { entry, bytes: fileBytes } of out) {
    assert.deepEqual(entry, expectedManifest.files[idx]);
    assert.deepEqual(await collect(fileBytes), data[idx], `file ${idx}`);
    idx++;
  }
  assert.equal(idx, files.length);
});

test("crypto: password mode -> decrypt with {password,wrapped,salt}", async () => {
  const { files, data } = sampleFiles();
  const expectedManifest = buildManifest(files);
  const password = "correct horse battery staple";

  const { blob, keyForUrl, wrapped } = await encryptFilesForUpload(files, { password });
  assert.equal(keyForUrl, "");
  assert.ok(wrapped);

  const cipher = await collect(blob);
  const { manifest, files: out } = await decryptFilesFromDownload(one(cipher), {
    password,
    wrapped: wrapped!.wrapped,
    salt: wrapped!.salt,
  });
  assert.deepEqual(manifest.files, expectedManifest.files);
  assert.equal(manifest.cf, 2, "password-mode multi-file is also cf=2 (seekable)");

  let idx = 0;
  for await (const { bytes: fileBytes } of out) {
    assert.deepEqual(await collect(fileBytes), data[idx], `file ${idx}`);
    idx++;
  }
  assert.equal(idx, files.length);
});

test("crypto: a wrong URL key fails to decrypt the manifest", async () => {
  const { files } = sampleFiles();
  const { blob } = await encryptFilesForUpload(files);
  const cipher = await collect(blob);
  const wrong = await encryptFilesForUpload(files);
  await assert.rejects(() =>
    decryptFilesFromDownload(one(cipher), { keyFromUrl: wrong.keyForUrl }),
  );
});

test("crypto: the server-visible blob leaks neither a filename nor content", async () => {
  const marker = "TOPSECRET_MULTI_PAYLOAD";
  const files: PackFile[] = [
    packFile("secret-name-a.txt", "text/plain", new TextEncoder().encode(marker)),
    packFile("secret-name-b.txt", "text/plain", new TextEncoder().encode("more")),
  ];
  const { blob } = await encryptFilesForUpload(files);
  const hay = new TextDecoder("latin1").decode(await collect(blob));
  assert.ok(!hay.includes(marker), "content leaked");
  assert.ok(!hay.includes("secret-name"), "filename leaked");
});

test("crypto cf=2: baseNonce/size stay inside enc_meta (zero-knowledge)", async () => {
  const { files, data } = sampleFiles();
  const { blob } = await encryptFilesForUpload(files);
  const total = data.reduce((a, d) => a + d.length, 0);
  const hay = new TextDecoder("latin1").decode(await collect(blob));
  assert.ok(!hay.includes(String(total)), "total size leaked into blob");
});

test("crypto cf=2: a chunk-range seek over the concat content is byte-exact", async () => {
  // The streaming preview's path without the network.
  const big = bytes(PT_CHUNK * 3 + 4096, 9);
  const files: PackFile[] = [packFile("movie.bin", "application/octet-stream", big)];
  const { blob, keyForUrl } = await encryptFilesForUpload(files);
  const cipher = await collect(blob);
  const key = decodeKey(keyForUrl);

  const { contentOffset } = peekBlobHeader(cipher);
  const { manifest } = await decryptFilesWithKey(one(cipher), key);
  assert.equal(manifest.cf, 2);
  const baseNonce = fromBase64(manifest.baseNonce!);
  const size = manifest.size!;

  const fetchRange = async (cStart: number, cEnd: number): Promise<Uint8Array> =>
    cipher.subarray(contentOffset + cStart, contentOffset + cEnd + 1);

  for (const [start, end] of [
    [0, 0],
    [PT_CHUNK - 3, PT_CHUNK + 3],
    [PT_CHUNK * 2 + 10, PT_CHUNK * 2 + 500],
    [size - 20, size - 1],
  ] as [number, number][]) {
    const out = await collect(
      decryptSeekableRange(fetchRange, key, baseNonce, size, start, end),
    );
    assert.deepEqual(out, big.subarray(start, end + 1), `range [${start}, ${end}]`);
  }
});

test("crypto: a cf=1 multi-file blob without cf in its manifest still decrypts", async () => {
  const { files, data } = sampleFiles();
  const manifest = buildManifest(files);
  const key = generateKey();
  const encMeta = encryptManifestRaw(manifest, key);
  const blob = assembleBlob(encMeta, encryptChunks(concatFiles(files), key));
  const cipher = await collect(blob);

  const { manifest: out, files: outFiles } = await decryptFilesFromDownload(
    one(cipher),
    { keyFromUrl: encodeKey(key) },
  );
  assert.ok(out.cf === undefined || out.cf === 1, "legacy multi blob is cf=1");
  let idx = 0;
  for await (const { bytes: fileBytes } of outFiles) {
    assert.deepEqual(await collect(fileBytes), data[idx], `file ${idx}`);
    idx++;
  }
  assert.equal(idx, files.length);
});
