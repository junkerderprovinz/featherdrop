import { test } from "node:test";
import assert from "node:assert/strict";
import { completeLicenses, sectionsWithoutText } from "../scripts/third-party-licenses.mjs";

const vite = `# Licenses

The app bundles dependencies which contain the following licenses:

## @rive-app/canvas-lite - 2.49.4 (MIT)

## @vue/shared - 3.5.45 (MIT)

The MIT License (MIT)

Copyright (c) 2018-present, Yuxi (Evan) You
`;

test("a package listed without its license text gets the text", () => {
  const md = completeLicenses(vite, [{ name: "@rive-app/canvas-lite", version: "2.49.4", license: "MIT", text: "MIT License\n\nCopyright (c) Rive\n" }]);
  assert.match(md, /## @rive-app\/canvas-lite - 2\.49\.4 \(MIT\)\n\nMIT License\n\nCopyright \(c\) Rive\n\n## @vue\/shared/);
  assert.equal(md.match(/## @rive-app/g)!.length, 1);
});

test("a package the bundle does not list is added with its text", () => {
  const md = completeLicenses(vite, [{ name: "libsodium-sumo", version: "0.8.4", license: "ISC", text: "Copyright (c) 2015-2026\n" }]);
  assert.match(md, /\n## libsodium-sumo - 0\.8\.4 \(ISC\)\n\nCopyright \(c\) 2015-2026\n$/);
});

test("a section without a license text is reported", () => {
  assert.deepEqual(sectionsWithoutText(vite), ["@rive-app/canvas-lite - 2.49.4 (MIT)"]);
  assert.deepEqual(sectionsWithoutText(completeLicenses(vite, [{ name: "@rive-app/canvas-lite", version: "2.49.4", license: "MIT", text: "MIT" }])), []);
});
