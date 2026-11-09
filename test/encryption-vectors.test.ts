// Checks the implementation against the fixtures in test/fixtures, which
// scripts/encryption-vectors.ts wrote once. The v2 vectors let a second
// implementation check itself; the legacy blobs pin that shares written by
// the older formats still open with the current code.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ready } from "../lib/e2e/crypto";
import { padme } from "../lib/e2e/v2/padding";
import { deriveKeys, passwordSalt, rootKey } from "../lib/e2e/v2/keys";
import { decodeToken } from "../lib/e2e/v2/token";
import { buildEncryptor, encryptStream, decryptShare, openKeys } from "../lib/e2e/v2/share";
import type { FileEntry, Kind } from "../lib/e2e/v2/layout";
import { decryptFromDownload, deriveContentKey } from "../lib/e2e/pipeline";
import { decryptFilesFromDownload } from "../lib/e2e/multi-pipeline";
import { computeKeyVerifier } from "../lib/e2e/crypto";
import { decryptFileInWorker, decryptBundleInWorker } from "../lib/e2e/v2/remote";
import { cryptoWorker } from "./crypto-worker";

interface KeyVector {
  name: string;
  token: string;
  password: string | null;
  salt: string | null;
  root: string;
  header_key: string;
  content_key: string;
  verifier: string;
}

interface BlobVector {
  name: string;
  token: string;
  password: string | null;
  kind: Kind;
  chunk: number;
  header_nonce: string;
  base_nonce: string;
  files: FileEntry[];
  header_json: string;
  plaintext: string;
  blob: string;
}

interface LegacyVector {
  name: string;
  format: 2 | 3;
  secret: { keyFromUrl: string } | { password: string; wrapped: string; salt: string };
  verifier: string;
  meta: unknown;
  sha256: string[];
  blob: string;
}

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const v2 = fixture("encryption-v2-vectors.json") as {
  padme: [number, number][];
  keys: KeyVector[];
  blobs: BlobVector[];
};
const legacy = fixture("legacy-blobs.json") as { blobs: LegacyVector[] };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function* one(b: Uint8Array) {
  yield b;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

before(async () => {
  await ready();
});

test("padme matches the vectors", () => {
  assert.ok(v2.padme.length > 0);
  for (const [len, want] of v2.padme) assert.equal(padme(len), want);
});

for (const k of v2.keys) {
  test(`the key schedule matches the vector "${k.name}"`, async () => {
    const token = decodeToken(k.token);
    const password = k.password ?? undefined;
    if (k.salt !== null) assert.equal(hex(await passwordSalt(token.secret)), k.salt);
    assert.equal(hex(await rootKey(token, password)), k.root);
    const keys = await deriveKeys(token, password);
    assert.equal(hex(keys.header), k.header_key);
    assert.equal(hex(keys.content), k.content_key);
    assert.equal(keys.verifier, k.verifier);
  });
}

for (const v of v2.blobs) {
  test(`the v2 blob "${v.name}" is reproduced byte for byte`, async () => {
    const keys = await openKeys(v.token, v.password ?? undefined);
    const enc = buildEncryptor({
      keys,
      kind: v.kind,
      files: v.files,
      chunk: v.chunk,
      headerNonce: unhex(v.header_nonce),
      baseNonce: unhex(v.base_nonce),
    });
    assert.equal(JSON.stringify(enc.header), v.header_json);
    const blob = await collect(encryptStream(enc, one(unhex(v.plaintext))));
    assert.equal(hex(blob), v.blob);
  });

  test(`the v2 blob "${v.name}" decrypts to its plaintext`, async () => {
    const keys = await openKeys(v.token, v.password ?? undefined);
    const { header, plaintext } = await decryptShare(one(unhex(v.blob)), keys);
    assert.deepEqual(header.files, v.files);
    assert.equal(hex(await collect(plaintext)), v.plaintext);
  });
}

for (const l of legacy.blobs) {
  test(`the legacy blob "${l.name}" still decrypts`, async () => {
    const secret =
      "keyFromUrl" in l.secret
        ? l.secret
        : {
            password: l.secret.password,
            wrapped: unb64(l.secret.wrapped),
            salt: unb64(l.secret.salt),
          };
    assert.equal(computeKeyVerifier(await deriveContentKey(secret)), l.verifier);
    if (l.format === 2) {
      const { meta, plaintext } = await decryptFromDownload(one(unb64(l.blob)), secret);
      assert.deepEqual(meta, l.meta);
      assert.equal(sha256(await collect(plaintext)), l.sha256[0]);
    } else {
      const { manifest, files } = await decryptFilesFromDownload(one(unb64(l.blob)), secret);
      assert.deepEqual(manifest, l.meta);
      const got: string[] = [];
      for await (const f of files) got.push(sha256(await collect(f.bytes)));
      assert.deepEqual(got, l.sha256);
    }
  });
}

for (const l of legacy.blobs) {
  test(`the legacy blob "${l.name}" decrypts through the crypto worker`, async () => {
    const worker = cryptoWorker();
    const secret =
      "keyFromUrl" in l.secret
        ? l.secret
        : { password: l.secret.password, wrapped: unb64(l.secret.wrapped), salt: unb64(l.secret.salt) };
    const { key, verifier } = await worker.request({ op: "legacy-key", secret });
    assert.equal(verifier, l.verifier);
    const blob = unb64(l.blob);
    async function* sliced() {
      for (let at = 0; at < blob.length; at += 777) yield blob.slice(at, at + 777);
    }
    if (l.format === 2) {
      const { meta, plaintext } = await decryptFileInWorker(worker, key, sliced());
      assert.deepEqual(meta, l.meta);
      assert.equal(sha256(await collect(plaintext)), l.sha256[0]);
    } else {
      const { manifest, files } = await decryptBundleInWorker(worker, key, sliced());
      assert.deepEqual(manifest, l.meta);
      const got: string[] = [];
      for await (const f of files) got.push(sha256(await collect(f.bytes)));
      assert.deepEqual(got, l.sha256);
    }
  });
}
