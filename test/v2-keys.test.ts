import { test } from "node:test";
import assert from "node:assert/strict";
import { newToken, deriveKeys, passwordSalt, ARGON2ID } from "../lib/e2e/v2/keys";
import {
  encodeToken,
  decodeToken,
  isPasswordLongEnough,
  MIN_PASSWORD_LENGTH,
} from "../lib/e2e/v2/token";

const SECRET = new Uint8Array(32).map((_, i) => i);

test("a link token round-trips and fits the URL fragment", async () => {
  for (const mode of ["link", "link+password"] as const) {
    const t = await newToken(mode);
    const s = encodeToken(t);
    assert.match(s, /^[A-Za-z0-9_-]{46}$/);
    const back = decodeToken(s);
    assert.equal(back.mode, mode);
    assert.deepEqual(back.secret, t.secret);
  }
});

test("a malformed link token is rejected", () => {
  const good = encodeToken({ mode: "link", secret: SECRET });
  assert.throws(() => decodeToken(good.slice(0, -2)), /token/);
  assert.throws(() => decodeToken("B" + good.slice(1)), /token/);
  const bytes = Buffer.from(good, "base64url");
  bytes[1] = 0x7f;
  assert.throws(() => decodeToken(bytes.toString("base64url")), /token/);
  assert.throws(() => decodeToken("not base64 !"), /token/);
});

test("fresh tokens carry fresh secrets", async () => {
  const a = await newToken("link");
  const b = await newToken("link");
  assert.notDeepEqual(a.secret, b.secret);
});

test("the subkeys and the verifier are all distinct", async () => {
  const k = await deriveKeys({ mode: "link", secret: SECRET });
  assert.equal(k.header.length, 32);
  assert.equal(k.content.length, 32);
  assert.match(k.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notDeepEqual(k.header, k.content);
  assert.notDeepEqual(k.header, SECRET);
  assert.notDeepEqual(k.content, SECRET);
  assert.notEqual(k.verifier, Buffer.from(k.content).toString("base64url"));
});

test("the mode is bound into the keys", async () => {
  const link = await deriveKeys({ mode: "link", secret: SECRET });
  const both = await deriveKeys({ mode: "link+password", secret: SECRET }, "correct horse");
  assert.notDeepEqual(link.content, both.content);
  assert.notEqual(link.verifier, both.verifier);
});

test("link and password mode needs both the secret and the password", async () => {
  const base = await deriveKeys({ mode: "link+password", secret: SECRET }, "correct horse");
  const otherPw = await deriveKeys({ mode: "link+password", secret: SECRET }, "correct horsf");
  const otherSecret = SECRET.slice();
  otherSecret[31] ^= 1;
  const otherLink = await deriveKeys({ mode: "link+password", secret: otherSecret }, "correct horse");
  assert.notDeepEqual(base.content, otherPw.content);
  assert.notEqual(base.verifier, otherPw.verifier);
  assert.notDeepEqual(base.content, otherLink.content);
  assert.notEqual(base.verifier, otherLink.verifier);
});

test("link and password mode refuses a missing password, link mode an extra one", async () => {
  await assert.rejects(deriveKeys({ mode: "link+password", secret: SECRET }), /password/);
  await assert.rejects(deriveKeys({ mode: "link", secret: SECRET }, "x"), /password/);
});

test("composed and decomposed spellings of a password derive the same keys", async () => {
  const composed = await deriveKeys({ mode: "link+password", secret: SECRET }, "café au lait");
  const decomposed = await deriveKeys({ mode: "link+password", secret: SECRET }, "café au lait");
  assert.deepEqual(composed.content, decomposed.content);
});

test("the password salt comes from the link secret alone", async () => {
  const salt = await passwordSalt(SECRET);
  assert.equal(salt.length, 16);
  assert.deepEqual(await passwordSalt(SECRET.slice()), salt);
  const other = SECRET.slice();
  other[0] ^= 1;
  assert.notDeepEqual(await passwordSalt(other), salt);
});

test("the keys record the Argon2id parameters they used", async () => {
  const k = await deriveKeys({ mode: "link+password", secret: SECRET }, "correct horse");
  assert.deepEqual(k.kdf, { alg: "argon2id13", ops: ARGON2ID.ops, mem: ARGON2ID.mem });
  const l = await deriveKeys({ mode: "link", secret: SECRET });
  assert.equal(l.kdf, null);
});

test("passwords shorter than the minimum are refused, counted in code points", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(isPasswordLongEnough("1234567"), false);
  assert.equal(isPasswordLongEnough("12345678"), true);
  assert.equal(isPasswordLongEnough("\u{1F512}".repeat(7)), false);
  assert.equal(isPasswordLongEnough("\u{1F512}".repeat(8)), true);
  assert.equal(isPasswordLongEnough("caféabc"), false);
});
