// Writes test/fixtures/encryption-v2-vectors.json and legacy-blobs.json.
// Run once with `node --import tsx scripts/encryption-vectors.ts`; the
// fixtures are committed and must not change afterwards, since they pin the
// formats. The legacy blobs use random nonces, so a rerun gives different but
// equally valid bytes.

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ready, PT_CHUNK } from "../lib/e2e/crypto";
import { encryptForUpload, decryptFromDownload } from "../lib/e2e/pipeline";
import { encryptFilesForUpload, decryptFilesFromDownload } from "../lib/e2e/multi-pipeline";
import { padme } from "../lib/e2e/v2/padding";
import { encodeToken, deriveKeys, passwordSalt, rootKey, type LinkToken } from "../lib/e2e/v2/keys";
import { buildEncryptor, encryptStream, type FileEntry, type Kind } from "../lib/e2e/v2/share";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const counting = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 0xff);

async function* one(b: Uint8Array) {
  yield b;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

const PASSWORD = "correct horse battery staple";
// Typed on macOS this arrives decomposed (NFD); it must derive the same keys.
const UMLAUT_PASSWORD = "Grüße aus Österreich";
const LINK: LinkToken = { mode: "link", secret: counting(32, 1) };
const BOTH: LinkToken = { mode: "link+password", secret: counting(32, 2) };

async function keyVector(name: string, token: LinkToken, password?: string) {
  const keys = await deriveKeys(token, password);
  return {
    name,
    token: encodeToken(token),
    password: password ?? null,
    salt: password === undefined ? null : hex(await passwordSalt(token.secret)),
    root: hex(await rootKey(token, password)),
    header_key: hex(keys.header),
    content_key: hex(keys.content),
    verifier: keys.verifier,
  };
}

async function blobVector(
  name: string,
  token: LinkToken,
  password: string | undefined,
  kind: Kind,
  files: FileEntry[],
  chunk: number,
  seed: number,
) {
  const keys = await deriveKeys(token, password);
  const headerNonce = counting(24, seed);
  const baseNonce = counting(24, seed + 1);
  const plaintext = counting(files.reduce((s, f) => s + f.size, 0), seed + 2);
  const enc = buildEncryptor({ keys, kind, files, chunk, headerNonce, baseNonce });
  return {
    name,
    token: encodeToken(token),
    password: password ?? null,
    kind,
    chunk,
    header_nonce: hex(headerNonce),
    base_nonce: hex(baseNonce),
    files,
    header_json: JSON.stringify(enc.header),
    plaintext: hex(plaintext),
    blob: hex(await collect(encryptStream(enc, one(plaintext)))),
  };
}

async function legacySingle(name: string, size: number, opts: { password?: string; seekable?: boolean }) {
  const data = counting(size, size);
  const meta = { name: "Jahresbericht (final).pdf", type: "application/pdf", size };
  const r = await encryptForUpload(one(data), meta, opts);
  const blob = await collect(r.blob);
  const secret = r.wrapped
    ? { password: opts.password as string, wrapped: b64(r.wrapped.wrapped), salt: b64(r.wrapped.salt) }
    : { keyFromUrl: r.keyForUrl };
  const decSecret = r.wrapped ? { password: opts.password as string, ...r.wrapped } : { keyFromUrl: r.keyForUrl };
  const dec = await decryptFromDownload(one(blob), decSecret);
  await collect(dec.plaintext);
  return { name, format: 2, secret, verifier: r.keyVerifier, meta: dec.meta, sha256: [sha256(data)], blob: b64(blob) };
}

async function legacyBundle(name: string, lastSize: number, password?: string) {
  const sizes = [3, 0, lastSize];
  const datas = sizes.map((n, i) => counting(n, 40 + i));
  const files = sizes.map((size, i) => ({
    name: `file-${i}.bin`,
    type: "application/octet-stream",
    size,
    stream: () => one(datas[i]),
  }));
  const r = await encryptFilesForUpload(files, password ? { password } : undefined);
  const blob = await collect(r.blob);
  const secret = r.wrapped
    ? { password: password as string, wrapped: b64(r.wrapped.wrapped), salt: b64(r.wrapped.salt) }
    : { keyFromUrl: r.keyForUrl };
  const decSecret = r.wrapped ? { password: password as string, ...r.wrapped } : { keyFromUrl: r.keyForUrl };
  const { manifest, files: out } = await decryptFilesFromDownload(one(blob), decSecret);
  for await (const f of out) await collect(f.bytes);
  return { name, format: 3, secret, verifier: r.keyVerifier, meta: manifest, sha256: datas.map(sha256), blob: b64(blob) };
}

await ready();
mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });

const v2 = {
  format: "CastleParcel encryption format v2, see docs/encryption-format.md",
  padme: [0, 1, 2, 3, 9, 100, 1000, 1025, 4096, 65537, 1_000_000, 2 ** 40 + 1, 2 ** 52 - 1].map((n) => [n, padme(n)]),
  keys: [
    await keyVector("link", LINK),
    await keyVector("link and password", BOTH, PASSWORD),
    await keyVector("link and password, NFC password", BOTH, UMLAUT_PASSWORD.normalize("NFC")),
    await keyVector("link and password, the same password in NFD", BOTH, UMLAUT_PASSWORD.normalize("NFD")),
  ],
  blobs: [
    await blobVector("single, link, empty", LINK, undefined, "single", [{ name: "empty.txt", type: "text/plain", size: 0 }], 65536, 10),
    await blobVector("single, link, three chunks", LINK, undefined, "single", [{ name: "Grüße.bin", type: "application/octet-stream", size: 9000 }], 4096, 20),
    await blobVector(
      "bundle, link and password",
      BOTH,
      PASSWORD,
      "bundle",
      [
        { name: "a.txt", type: "text/plain", size: 5 },
        { name: "b", type: "", size: 0 },
        { name: "c.jpg", type: "image/jpeg", size: 4100 },
      ],
      4096,
      30,
    ),
    // Padmé rounds 262145 up to 270336, so the last chunk is padding only.
    await blobVector("single, link, a whole chunk of padding", LINK, undefined, "single", [{ name: "pad.bin", type: "", size: 262145 }], 4096, 40),
  ],
};

const legacy = {
  blobs: [
    await legacySingle("format 2, secretstream, link", PT_CHUNK + 9, {}),
    await legacySingle("format 2, seekable, link", PT_CHUNK + 9, { seekable: true }),
    await legacySingle("format 2, seekable, password", 1000, { password: PASSWORD, seekable: true }),
    await legacyBundle("format 3, link", PT_CHUNK + 9),
    await legacyBundle("format 3, password", 500, PASSWORD),
  ],
};

writeFileSync(new URL("../test/fixtures/encryption-v2-vectors.json", import.meta.url), JSON.stringify(v2, null, 1) + "\n");
writeFileSync(new URL("../test/fixtures/legacy-blobs.json", import.meta.url), JSON.stringify(legacy, null, 1) + "\n");
