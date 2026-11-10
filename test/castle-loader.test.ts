import { test } from "node:test";
import assert from "node:assert/strict";
import { castleReach, castleStage, logoHeight, setCastle, stillCastle, type CastleInput } from "../lib/castle-loader";

const inputs = (): CastleInput[] => [
  { name: "mode", value: -1 },
  { name: "progress", value: -1 },
  { name: "still", value: false },
  { name: "reach", value: -1 },
];
const values = (list: CastleInput[]) => Object.fromEntries(list.map((i) => [i.name, i.value]));

test("an upload flies letters in, a download flies them out, idle leaves the tower alone", () => {
  for (const [mode, number] of [["upload", 1], ["download", 2], ["idle", 0]] as const) {
    const list = inputs();
    setCastle(list, { mode, progress: 0, still: false, reach: 0 });
    assert.equal(values(list).mode, number, mode);
  }
});

test("progress reaches the animation in percent", () => {
  const list = inputs();
  setCastle(list, { mode: "upload", progress: 0.42, still: false, reach: 0 });
  assert.equal(values(list).progress, 42);
});

test("progress beyond either end reaches the animation as empty or full", () => {
  const list = inputs();
  setCastle(list, { mode: "download", progress: -0.3, still: false, reach: 0 });
  assert.equal(values(list).progress, 0);
  setCastle(list, { mode: "download", progress: 1.7, still: false, reach: 0 });
  assert.equal(values(list).progress, 100);
});

test("a transfer that has not reported progress yet reaches the animation as empty", () => {
  const list = inputs();
  setCastle(list, { mode: "upload", progress: null, still: false, reach: 0 });
  assert.equal(values(list).progress, 0);
});

test("still reaches the animation as it is", () => {
  const list = inputs();
  setCastle(list, { mode: "upload", progress: 0.5, still: true, reach: 0 });
  assert.equal(values(list).still, true);
  setCastle(list, { mode: "upload", progress: 0.5, still: false, reach: 0 });
  assert.equal(values(list).still, false);
});

test("reach reaches the animation as it is", () => {
  const list = inputs();
  setCastle(list, { mode: "download", progress: 0.5, still: false, reach: 37 });
  assert.equal(values(list).reach, 37);
});

test("a window no wider than the artboard needs no extra reach", () => {
  assert.equal(castleReach(360, 720), 0);
  assert.equal(castleReach(195, 358), 0);
});

test("reach grows with the distance to the window edge and stops at 100", () => {
  const wide = castleReach(954, 704);
  assert.ok(wide > 0 && wide < 100, String(wide));
  assert.ok(castleReach(1280, 704) > wide);
  assert.equal(castleReach(10000, 704), 100);
});

test("reach runs from 0 at the shortest lead to 100 at the longest", () => {
  assert.ok(Math.abs(castleReach((1645 / 1520) * 704, 704)) < 1e-9);
  assert.ok(Math.abs(castleReach((4500 / 1520) * 704, 704) - 100) < 1e-9);
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

test("the animated tower stands as tall as the logo and on the same spot", () => {
  for (const size of [96, 280]) {
    const stage = castleStage(size);
    const art = stage.width / 1520;
    // The tower spans 355.2 to 754.8 of the artboard, and the stage starts at 175.
    assert.ok(Math.abs(stage.top + (355.2 - 175) * art) < 1e-9, `${size}: top`);
    assert.ok(Math.abs(399.6 * art - logoHeight(size)) < 1e-9, `${size}: height`);
    const towerLeft = (74.71 / 729.19) * size;
    assert.ok(Math.abs(stage.left + 610.174 * art - towerLeft) < 1e-9, `${size}: left`);
  }
});

test("the stage holds the letters' band at 2 to 1", () => {
  const stage = castleStage(280);
  assert.ok(Math.abs(stage.width / stage.height - 2) < 1e-9);
});
