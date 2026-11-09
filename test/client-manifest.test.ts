import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildManifest, manifestJSON } from "../scripts/client-manifest.mjs";

// The Go server builds the same manifest from its embedded files, and
// server-go/internal/clientmanifest checks itself against this golden file too.
const testdata = fileURLToPath(
  new URL("../server-go/internal/clientmanifest/testdata/", import.meta.url),
);

test("the manifest matches the one the Go server builds, byte for byte", () => {
  const golden = readFileSync(testdata + "manifest.json", "utf8");
  assert.equal(manifestJSON(buildManifest(testdata + "webroot")), golden);
});
