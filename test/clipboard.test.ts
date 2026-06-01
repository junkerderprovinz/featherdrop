import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../lib/clipboard";

// The bug: on plain-HTTP LAN access (e.g. http://192.168.x.x:3000) the page is
// not a secure context, so navigator.clipboard is undefined and the modern copy
// silently fails. copyText must fall back to a legacy execCommand path.

test("uses the modern clipboard API when available (secure context)", async () => {
  let written: string | undefined;
  const nav = {
    clipboard: {
      writeText: async (t: string) => {
        written = t;
      },
    },
  } as unknown as Navigator;
  const ok = await copyText("hello", nav, undefined);
  assert.equal(ok, true);
  assert.equal(written, "hello");
});

test("falls back to execCommand when there is no clipboard API (plain HTTP)", async () => {
  const nav = {} as Navigator; // no clipboard
  let copied = false;
  const el = {
    value: "",
    style: {} as Record<string, string>,
    focus() {},
    select() {},
    setSelectionRange() {},
  };
  const doc = {
    createElement: () => el,
    body: { appendChild() {}, removeChild() {} },
    execCommand: (cmd: string) => {
      if (cmd === "copy") {
        copied = true;
        return true;
      }
      return false;
    },
  } as unknown as Document;
  const ok = await copyText("data", nav, doc);
  assert.equal(ok, true, "fallback should report success");
  assert.equal(copied, true, "execCommand('copy') should have run");
  assert.equal(el.value, "data", "the text should be placed for copying");
});

test("falls back when the modern API throws (e.g. permission denied)", async () => {
  const nav = {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  } as unknown as Navigator;
  let copied = false;
  const el = { value: "", style: {} as Record<string, string>, focus() {}, select() {} };
  const doc = {
    createElement: () => el,
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => {
      copied = true;
      return true;
    },
  } as unknown as Document;
  const ok = await copyText("x", nav, doc);
  assert.equal(ok, true);
  assert.equal(copied, true);
});

test("returns false when neither path is available", async () => {
  const ok = await copyText("x", {} as Navigator, undefined);
  assert.equal(ok, false);
});
