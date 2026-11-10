import { test } from "node:test";
import assert from "node:assert/strict";
import { setCastle, stillCastle, type CastleInput } from "../lib/castle-loader";

const inputs = (): CastleInput[] => [
  { name: "mode", value: -1 },
  { name: "progress", value: -1 },
  { name: "still", value: false },
];
const values = (list: CastleInput[]) => Object.fromEntries(list.map((i) => [i.name, i.value]));

test("an upload flies letters in, a download flies them out, idle leaves the tower alone", () => {
  for (const [mode, number] of [["upload", 1], ["download", 2], ["idle", 0]] as const) {
    const list = inputs();
    setCastle(list, { mode, progress: 0, still: false });
    assert.equal(values(list).mode, number, mode);
  }
});

test("the gate glows with the transfer's progress in percent", () => {
  const list = inputs();
  setCastle(list, { mode: "upload", progress: 0.42, still: false });
  assert.equal(values(list).progress, 42);
});

test("progress beyond either end lights the gate no further than empty or full", () => {
  const list = inputs();
  setCastle(list, { mode: "download", progress: -0.3, still: false });
  assert.equal(values(list).progress, 0);
  setCastle(list, { mode: "download", progress: 1.7, still: false });
  assert.equal(values(list).progress, 100);
});

test("a transfer that has not reported progress yet leaves the gate dark", () => {
  const list = inputs();
  setCastle(list, { mode: "upload", progress: null, still: false });
  assert.equal(values(list).progress, 0);
});

test("still reaches the animation as it is", () => {
  const list = inputs();
  setCastle(list, { mode: "upload", progress: 0.5, still: true });
  assert.equal(values(list).still, true);
  setCastle(list, { mode: "upload", progress: 0.5, still: false });
  assert.equal(values(list).still, false);
});

test("a system that asks for reduced motion rests the letter at the gate at every motion level", () => {
  for (const motion of ["off", "subtle", "wild"]) assert.equal(stillCastle(motion, true), true, motion);
});

test("motion off in the settings rests the letter at the gate", () => {
  assert.equal(stillCastle("off", false), true);
});

test("subtle and wild motion let the letters fly", () => {
  assert.equal(stillCastle("subtle", false), false);
  assert.equal(stillCastle("wild", false), false);
});
