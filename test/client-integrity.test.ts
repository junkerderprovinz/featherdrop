import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { addIntegrity } from "../scripts/client-integrity.mjs";

const sri = (data: string) =>
  "sha384-" + createHash("sha384").update(data).digest("base64");

const shell = `<!doctype html>
<html lang="%%LANG%%">
  <head>
    <title>%%APP_NAME%%</title>
    <script type="module" crossorigin src="/assets/index-a.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/runtime-b.js">
    <link rel="stylesheet" crossorigin href="/assets/index-c.css">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

const assets = new Map([
  ["assets/index-a.js", "entry"],
  ["assets/runtime-b.js", "runtime"],
  ["assets/index-c.css", "body{}"],
  ["assets/flag-f.svg", "<svg/>"],
  ["sw-download.js", "worker"],
]);
const read = (path: string) => {
  const data = assets.get(path);
  return data === undefined ? undefined : Buffer.from(data);
};
const assetPaths = [...assets.keys()];

test("every script, module preload and stylesheet in the shell gets its integrity", () => {
  const out = addIntegrity(shell, assetPaths, read);
  assert.ok(out.includes(`src="/assets/index-a.js" integrity="${sri("entry")}"`), out);
  assert.ok(out.includes(`href="/assets/runtime-b.js" integrity="${sri("runtime")}"`), out);
  assert.ok(out.includes(`href="/assets/index-c.css" integrity="${sri("body{}")}"`), out);
});

// A failed integrity check on a modulepreload does not stop a later import()
// from fetching the URL again, so a lazy chunk cannot be pinned at all.
test("a chunk the shell does not load stops the build", () => {
  for (const lazy of ["assets/sodium-d.js", "assets/lazy-e.css"]) {
    const read2 = (path: string) => (path === lazy ? Buffer.from("x") : read(path));
    assert.throws(() => addIntegrity(shell, [...assetPaths, lazy], read2), new RegExp(lazy));
  }
});

test("icons, images, the service worker and the template markers are left alone", () => {
  const out = addIntegrity(shell, assetPaths, read);
  assert.ok(out.includes(`<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`));
  assert.ok(!out.includes("flag-f.svg"));
  assert.ok(!out.includes("sw-download.js"));
  assert.ok(out.includes(`<html lang="%%LANG%%">`) && out.includes("<title>%%APP_NAME%%</title>"));
});

test("a script the build did not produce stops the build", () => {
  const broken = shell.replace("/assets/index-a.js", "/assets/missing.js");
  assert.throws(() => addIntegrity(broken, assetPaths, read), /missing\.js/);
});

test("an inline script stops the build, since nothing could pin it", () => {
  const inline = shell.replace("</head>", "<script>alert(1)</script></head>");
  assert.throws(() => addIntegrity(inline, assetPaths, read), /inline/);
});

test("an inline script in capitals stops the build like any other", () => {
  const shouting = shell.replace("<body>", "<body><SCRIPT>window.x = 1</SCRIPT>");
  assert.throws(() => addIntegrity(shouting, assetPaths, read), /inline script/);
});
