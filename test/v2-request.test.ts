import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newRequestSecret,
  requestKeys,
  encodeCollectLink,
  decodeCollectLink,
  encodeRequestKey,
  decodeRequestKey,
  sealToken,
  openSealedToken,
  SEALED_TOKEN_BYTES,
} from "../lib/e2e/v2/request";
import { createEncryptor, encryptStream, openKeys, decryptShare } from "../lib/e2e/v2/share";
import { decodeToken, encodeToken, newToken } from "../lib/e2e/v2/keys";

async function* one(b: Uint8Array) {
  yield b;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

const FIXED = new Uint8Array(32).fill(5);

test("the keys of a request follow from its secret alone", async () => {
  const a = await requestKeys(FIXED);
  const b = await requestKeys(new Uint8Array(FIXED));
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.deepEqual(a.secretKey, b.secretKey);
  assert.equal(a.collectToken, b.collectToken);
  assert.equal(a.publicKey.length, 32);
  assert.match(a.collectToken, /^[A-Za-z0-9_-]{43}$/);
  const other = await requestKeys(await newRequestSecret());
  assert.notDeepEqual(other.publicKey, a.publicKey);
  assert.notEqual(other.collectToken, a.collectToken);
});

test("an upload sealed to a request opens with its collect link", async () => {
  const secret = await newRequestSecret();
  const keys = await requestKeys(secret);
  const plain = new TextEncoder().encode("for your eyes only");
  const enc = await createEncryptor([{ name: "letter.txt", type: "text/plain", size: plain.length }]);
  const blob = await collect(encryptStream(enc, one(plain)));
  const sealed = await sealToken(enc.token, keys.publicKey);
  assert.equal(sealed.length, SEALED_TOKEN_BYTES);

  // The requester has only the collect link.
  const collected = await requestKeys(decodeCollectLink(encodeCollectLink(secret)));
  const token = await openSealedToken(sealed, collected);
  assert.equal(token, enc.token);
  const { header, plaintext } = await decryptShare(one(blob), await openKeys(token));
  assert.equal(header.files[0].name, "letter.txt");
  assert.deepEqual(await collect(plaintext), plain);
});

test("a request link holds the public key and nothing that collects", async () => {
  const secret = await newRequestSecret();
  const keys = await requestKeys(secret);
  const link = encodeRequestKey(keys.publicKey);
  assert.equal(link.length, 46);
  assert.deepEqual(decodeRequestKey(link), keys.publicKey);
  // A request link is no collect link and the other way round.
  assert.throws(() => decodeCollectLink(link), /kind/);
  assert.throws(() => decodeRequestKey(encodeCollectLink(secret)), /kind/);
  const raw = Buffer.from(link, "base64url");
  assert.ok(!raw.includes(Buffer.from(keys.collectToken, "base64url")));
});

test("links of either kind are no share tokens", async () => {
  const keys = await requestKeys(FIXED);
  assert.throws(() => decodeToken(encodeCollectLink(FIXED)), /mode/);
  assert.throws(() => decodeToken(encodeRequestKey(keys.publicKey)), /mode/);
  assert.throws(() => decodeCollectLink("AAAA"), /length/);
  assert.throws(() => decodeCollectLink("!".repeat(46)), /base64url/);
});

test("another request's keys cannot open a sealed token", async () => {
  const mine = await requestKeys(await newRequestSecret());
  const theirs = await requestKeys(await newRequestSecret());
  const token = encodeToken(await newToken("link"));
  const sealed = await sealToken(token, mine.publicKey);
  await assert.rejects(openSealedToken(sealed, theirs), /does not open/);
  const flipped = sealed.slice();
  flipped[40] ^= 1;
  await assert.rejects(openSealedToken(flipped, mine), /does not open/);
});

test("a sealed token has to be a link-mode share token", async () => {
  const keys = await requestKeys(FIXED);
  const withPassword = encodeToken(await newToken("link+password"));
  await assert.rejects(sealToken(withPassword, keys.publicKey), /link mode/);
});
