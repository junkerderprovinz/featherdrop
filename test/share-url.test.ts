import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShareUrl } from "../lib/share-url";

// Share links must use the operator's configured BASE_URL when set (behind a
// reverse proxy / custom domain), regardless of how the uploader reached the
// page (internal IP, DNS name, tailnet address). When BASE_URL is empty the
// link falls back to the browser's current origin.

test("uses BASE_URL when set, ignoring the browser origin", () => {
  assert.equal(
    buildShareUrl("https://share.example.com", "http://192.168.1.5:3000", "abc123", "KEY"),
    "https://share.example.com/d/abc123#k=KEY",
  );
});

test("falls back to the browser origin when BASE_URL is empty", () => {
  assert.equal(
    buildShareUrl("", "http://192.168.1.5:3000", "abc123", "KEY"),
    "http://192.168.1.5:3000/d/abc123#k=KEY",
  );
});

test("no #k fragment when there is no link key (server master-key mode)", () => {
  assert.equal(
    buildShareUrl("https://s.example.com", "http://x", "abc123", ""),
    "https://s.example.com/d/abc123",
  );
});

test("strips a trailing slash on BASE_URL (no double slash)", () => {
  assert.equal(
    buildShareUrl("https://s.example.com/", "http://x", "abc123", "K"),
    "https://s.example.com/d/abc123#k=K",
  );
});

test("returns an empty string without a slug", () => {
  assert.equal(buildShareUrl("https://s.example.com", "http://x", "", "K"), "");
});
