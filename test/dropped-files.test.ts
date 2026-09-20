import { test } from "node:test";
import assert from "node:assert/strict";
import { filesFromDropEvent } from "../lib/dropped-files";

// A drop reads dataTransfer.files and never the webkitGetAsEntry() path that
// crashes Chromium (#4); the picker's target.files goes through the same helper.
const mk = (name: string) => new File(["x"], name, { type: "text/plain" });

test("reads files from a drag-and-drop event (dataTransfer.files)", () => {
  const a = mk("a.txt");
  assert.deepEqual(filesFromDropEvent({ dataTransfer: { files: [a] } }), [a]);
});

test("reads files from a file-picker change event (target.files)", () => {
  const a = mk("b.txt");
  assert.deepEqual(filesFromDropEvent({ target: { files: [a] } }), [a]);
});

test("returns [] when no files are present", () => {
  assert.deepEqual(filesFromDropEvent({ dataTransfer: { files: [] } }), []);
  assert.deepEqual(filesFromDropEvent({}), []);
  assert.deepEqual(filesFromDropEvent(null), []);
});

test("never reads DataTransfer.items / webkitGetAsEntry (the crash path)", () => {
  const a = mk("c.txt");
  let itemsTouched = false;
  const evt = {
    dataTransfer: {
      files: [a],
      get items() {
        itemsTouched = true;
        throw new Error("items must not be read");
      },
    },
  };
  assert.deepEqual(filesFromDropEvent(evt), [a]);
  assert.equal(itemsTouched, false);
});
