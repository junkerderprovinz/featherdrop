import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ready, PT_CHUNK, decodeKey } from "../lib/e2e/crypto";
import { fromBase64, computeKeyVerifier } from "../lib/e2e/crypto";
import { contentOffsetForMetaLen, peekBlobHeader } from "../lib/e2e/blob-layout";
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

// helpers --------------------------------------------------------------------

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

/** A PackFile whose stream yields the given bytes (in a few pieces, to exercise
 *  chunk boundaries that don't line up with PT_CHUNK). */
function packFile(name: string, type: string, data: Uint8Array): PackFile {
  return {
    name,
    type,
    size: data.length,
    stream: async function* () {
      // Emit in ~40 KiB pieces so multi-chunk files arrive across several yields.
      const piece = 40000;
      for (let i = 0; i < data.length; i += piece) {
        yield data.subarray(i, i + piece);
      }
    },
  };
}

// Three varied files: one spanning chunk boundaries (> 64 KiB), one 0-byte,
// one 1-byte. Used by both the pure and the crypto round-trip tests.
function sampleFiles(): { files: PackFile[]; data: Uint8Array[] } {
  const data = [
    bytes(PT_CHUNK * 2 + 123, 1), // larger than 64 KiB, crosses chunk boundaries
    bytes(0, 2), // 0-byte file
    bytes(1, 3), // 1-byte file
  ];
  const files = [
    packFile("report.bin", "application/octet-stream", data[0]),
    packFile("empty.txt", "text/plain", data[1]),
    packFile("one.dat", "application/octet-stream", data[2]),
  ];
  return { files, data };
}

// (a) PURE — concat + split, no crypto ---------------------------------------

test("pure: concatFiles -> splitByManifest reassembles N files byte-exact", async () => {
  const { files, data } = sampleFiles();
  const manifest = buildManifest(files);

  // manifest entries are correct (name/type/size)
  assert.deepEqual(manifest.files, [
    { name: "report.bin", type: "application/octet-stream", size: data[0].length },
    { name: "empty.txt", type: "text/plain", size: 0 },
    { name: "one.dat", type: "application/octet-stream", size: 1 },
  ]);

  // drain each per-file generator IN ORDER and reassemble
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

  // Source carries everything except the final byte of the last file.
  const full = await collect(concatFiles(files));
  const short = full.subarray(0, full.length - 1);

  await assert.rejects(
    async () => {
      for await (const { bytes: fileBytes } of splitByManifest(one(short), manifest)) {
        await collect(fileBytes); // drain in order until the short source runs out
      }
    },
    /truncated/,
  );

  // sanity: with the full source it does NOT throw
  let total = 0;
  for await (const { bytes: fileBytes } of splitByManifest(one(full), manifest)) {
    total += (await collect(fileBytes)).length;
  }
  assert.equal(total, data.reduce((a, d) => a + d.length, 0));
});

test("pure: concatFiles throws when a file yields FEWER bytes than its size", async () => {
  // Declare size 100 but the stream only emits 60 bytes (file shrank on disk).
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

test("pure: concatFiles throws when a file yields MORE bytes than its size", async () => {
  // Declare size 50 but the stream emits 80 bytes (file grew on disk).
  const f: PackFile = {
    name: "grown.bin",
    type: "application/octet-stream",
    size: 50,
    stream: async function* () {
      yield bytes(30, 6);
      yield bytes(50, 7); // total 80 > 50 — must throw mid-stream
    },
  };
  await assert.rejects(
    async () => {
      for await (const _ of concatFiles([f])) void _;
    },
    /grown\.bin.*grew during upload/,
  );
});

// (b) FULL crypto round-trip -------------------------------------------------

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
  // The file list is preserved exactly; NEW multi-file uploads are cf=2 (seekable),
  // so the manifest also carries cf/chunkSize/baseNonce + the total concat size.
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
  const wrong = await encryptFilesForUpload(files); // a different random key
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

// (c) cf=2 seekable: zero-knowledge + true seek over the concatenated content ──

test("crypto cf=2: baseNonce/size stay inside enc_meta (zero-knowledge)", async () => {
  const { files, data } = sampleFiles();
  const { blob } = await encryptFilesForUpload(files);
  const total = data.reduce((a, d) => a + d.length, 0);
  const hay = new TextDecoder("latin1").decode(await collect(blob));
  // The total concatenated size lives only inside the encrypted manifest.
  assert.ok(!hay.includes(String(total)), "total size leaked into blob");
});

test("crypto cf=2: a chunk-range seek over the concat content is byte-exact", async () => {
  // A bundle whose concatenated content spans several cf=2 chunks; decrypt an
  // arbitrary PLAINTEXT range straight off the cipher region (the same path the
  // streaming preview uses, minus the network).
  const big = bytes(PT_CHUNK * 3 + 4096, 9);
  const files: PackFile[] = [packFile("movie.bin", "application/octet-stream", big)];
  const { blob, keyForUrl } = await encryptFilesForUpload(files);
  const cipher = await collect(blob);
  const key = decodeKey(keyForUrl);

  // Read the header to learn the content offset + manifest (baseNonce/size).
  const { contentOffset } = peekBlobHeader(cipher);
  const { manifest } = await decryptFilesWithKey(one(cipher), key);
  assert.equal(manifest.cf, 2);
  const baseNonce = fromBase64(manifest.baseNonce!);
  const size = manifest.size!;

  // fetchCipherRange over the CONTENT region (absolute = contentOffset + rel).
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
  void contentOffsetForMetaLen;
  void computeKeyVerifier;
});

// (d) BACK-COMPAT: a cf=1 (secretstream) multi-file blob still decrypts ────────

test("crypto: a legacy cf=1 multi-file blob still decrypts via the branched path", async () => {
  // Build the blob the OLD way: secretstream content + a manifest WITHOUT cf.
  // decryptFilesWithKey must route it through the secretstream path.
  const { files, data } = sampleFiles();
  const manifest = buildManifest(files); // no cf field → cf=1
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
