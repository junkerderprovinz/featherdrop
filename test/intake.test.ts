import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Enough of a window for the intake: it listens on the window and the
// document, and asks which element has the focus.
class HTMLInputElement {}
class HTMLTextAreaElement {}
const page = new EventTarget();
const doc = Object.assign(new EventTarget(), {
  cookie: "",
  activeElement: {} as unknown,
  createElement: () => ({}),
  documentElement: { lang: "", dir: "", dataset: {} },
});

let intake: typeof import("../src/intake");

before(async () => {
  Object.assign(globalThis, {
    HTMLInputElement,
    HTMLTextAreaElement,
    document: doc,
    addEventListener: page.addEventListener.bind(page),
  });
  intake = await import("../src/intake");
  intake.installIntake();
});

beforeEach(() => {
  doc.activeElement = {};
});

const file = (name: string) => new File(["x"], name);

function paste(data: { files?: File[]; text?: string }) {
  const e = Object.assign(new Event("paste", { cancelable: true }), {
    clipboardData: { files: data.files ?? [], getData: (type: string) => (type === "text/plain" ? (data.text ?? "") : "") },
  });
  doc.dispatchEvent(e);
  return e;
}

function drag(type: "dragover" | "drop", files: File[]) {
  const e = Object.assign(new Event(type, { cancelable: true }), {
    dataTransfer: { files, types: files.length ? ["Files"] : ["text/plain"] },
  });
  page.dispatchEvent(e);
  return e;
}

test("text pasted outside a field goes to the screen that writes notes", () => {
  const texts: string[] = [];
  const stop = intake.takeFiles(() => {}, (text) => texts.push(text));
  const e = paste({ text: "the gate code is 4711" });
  stop();
  assert.deepEqual(texts, ["the gate code is 4711"]);
  assert.ok(e.defaultPrevented);
});

test("text pasted into a field stays in the field", () => {
  const texts: string[] = [];
  const stop = intake.takeFiles(() => {}, (text) => texts.push(text));
  doc.activeElement = new HTMLTextAreaElement();
  const e = paste({ text: "typed elsewhere" });
  stop();
  assert.deepEqual(texts, []);
  assert.ok(!e.defaultPrevented);
});

test("pasted text is left alone where no screen writes notes", () => {
  const stop = intake.takeFiles(() => {});
  const e = paste({ text: "nowhere to go" });
  stop();
  assert.ok(!e.defaultPrevented);
});

test("pasted files go to the screen even when text comes with them", () => {
  const got: File[][] = [];
  const texts: string[] = [];
  const stop = intake.takeFiles((files) => got.push(files), (text) => texts.push(text));
  paste({ files: [file("shot.png")], text: "shot.png" });
  stop();
  assert.deepEqual(got.map((f) => f.map((x) => x.name)), [["shot.png"]]);
  assert.deepEqual(texts, []);
});

test("files dragged over any part of the window arm the drop zone and land on drop", () => {
  const got: File[][] = [];
  const stop = intake.takeFiles((files) => got.push(files));
  const over = drag("dragover", [file("a.txt")]);
  assert.ok(over.defaultPrevented, "the window accepts the drag");
  assert.equal(intake.dragging.value, true);
  drag("drop", [file("a.txt")]);
  stop();
  assert.equal(intake.dragging.value, false);
  assert.deepEqual(got.map((f) => f.map((x) => x.name)), [["a.txt"]]);
});
