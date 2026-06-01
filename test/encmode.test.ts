import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseEncMode } from "../lib/encmode";

// Which encryption mode a new upload gets, given whether the uploader set a
// password and whether a server master key is configured.
//   - password set                      -> "password" (key wrapped with the pw)
//   - no password, master key present    -> "server"   (key wrapped with master)
//   - no password, no master key         -> "link"     (key rides in #fragment)

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
