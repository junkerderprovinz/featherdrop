import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSodiumOnce, sodiumWasm } from "../scripts/sodium-once.mjs";

const WASM = "AGFzbQEAAAAB" + "x".repeat(64);

test("the WebAssembly module is read from the installed libsodium", () => {
  const source = readFileSync("node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs", "utf8");
  const wasm = sodiumWasm(source);
  assert.match(wasm.slice(0, 12), /^AGFzbQ/);
  assert.ok(wasm.length > 100_000, `${wasm.length} characters`);
});

test("a chunk with libsodium only inside the worker string passes", () => {
  const chunk = `const w='var s=Uint8Array.from(atob("${WASM}"))';new Worker(URL.createObjectURL(new Blob([w])))`;
  assert.doesNotThrow(() => checkSodiumOnce([{ path: "assets/index-a.js", text: chunk }], WASM));
});

test("a chunk that ships libsodium twice fails the build", () => {
  const chunk = `let a="${WASM}";const w='var s="${WASM}"'`;
  assert.throws(() => checkSodiumOnce([{ path: "assets/index-a.js", text: chunk }], WASM), /2 copies/);
});

test("a build in which the check finds no libsodium fails instead of passing blind", () => {
  assert.throws(() => checkSodiumOnce([{ path: "assets/index-a.js", text: "console.log(1)" }], WASM), /no copy/);
});

test("copies spread over several chunks count together", () => {
  const files = [
    { path: "assets/index-a.js", text: `"${WASM}"` },
    { path: "assets/other-b.js", text: `"${WASM}"` },
  ];
  assert.throws(() => checkSodiumOnce(files, WASM), /index-a\.js, assets\/other-b\.js/);
});
