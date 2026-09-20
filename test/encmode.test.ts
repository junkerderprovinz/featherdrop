import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseEncMode } from "../lib/encmode";

test("a password always yields password mode", () => {
  assert.equal(chooseEncMode(true, true), "password");
  assert.equal(chooseEncMode(true, false), "password");
});

test("no password + master key configured -> server mode (short links)", () => {
  assert.equal(chooseEncMode(false, true), "server");
});

test("no password + no master key -> link mode (#fragment fallback)", () => {
  assert.equal(chooseEncMode(false, false), "link");
});
