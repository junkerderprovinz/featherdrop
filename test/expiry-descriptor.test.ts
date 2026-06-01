import { test } from "node:test";
import assert from "node:assert/strict";
import { describeExpiry } from "../lib/format";

const NOW = 1_000_000_000_000;

test("null expiry -> never", () => {
  assert.deepEqual(describeExpiry(null, NOW), { kind: "never" });
});

test("past expiry -> expired", () => {
  assert.deepEqual(describeExpiry(NOW - 1000, NOW), { kind: "expired" });
});

test("under an hour -> minutes with rounded count", () => {
  assert.deepEqual(describeExpiry(NOW + 25 * 60_000, NOW), {
    kind: "minutes",
    count: 25,
  });
});

test("under two days -> hours", () => {
  assert.deepEqual(describeExpiry(NOW + 5 * 3_600_000, NOW), {
    kind: "hours",
    count: 5,
  });
});

test("two days or more -> days", () => {
  assert.deepEqual(describeExpiry(NOW + 7 * 24 * 3_600_000, NOW), {
    kind: "days",
    count: 7,
  });
});

test("exactly 60 minutes rolls into hours", () => {
  assert.deepEqual(describeExpiry(NOW + 60 * 60_000, NOW), {
    kind: "hours",
    count: 1,
  });
});
