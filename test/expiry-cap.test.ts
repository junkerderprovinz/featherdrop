import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedExpiryOptions, clampExpiry, EXPIRY_OPTIONS } from "../lib/expiry";

const values = (max: string) => allowedExpiryOptions(max).map((o) => o.value);

test("no cap (empty / never / invalid) offers every option", () => {
  assert.deepEqual(values(""), EXPIRY_OPTIONS.map((o) => o.value));
  assert.deepEqual(values("never"), EXPIRY_OPTIONS.map((o) => o.value));
  assert.deepEqual(values("13d"), EXPIRY_OPTIONS.map((o) => o.value));
});

test("a finite cap cuts the list after the cap (and drops 'never')", () => {
  assert.deepEqual(values("1d"), ["1h", "6h", "1d"]);
  assert.deepEqual(values("30d"), ["1h", "6h", "1d", "7d", "30d"]);
  assert.deepEqual(values("1h"), ["1h"]);
});

test("clampExpiry keeps allowed values and clamps the rest to the cap", () => {
  assert.equal(clampExpiry("6h", "1d"), "6h"); // allowed → unchanged
  assert.equal(clampExpiry("30d", "1d"), "1d"); // over cap → the cap
  assert.equal(clampExpiry("never", "7d"), "7d"); // never under a finite cap → the cap
  assert.equal(clampExpiry("never", ""), "never"); // no cap → never stays
  assert.equal(clampExpiry("bogus", "1d"), "1d"); // invalid wanted → the cap
  assert.equal(clampExpiry("bogus", ""), "30d"); // invalid, no cap → longest finite
});
