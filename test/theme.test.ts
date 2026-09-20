import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A "use client" directive turns createAppTheme into a non-callable client
// reference for a server component that imports it, and every render fails.
test('theme.ts is not a "use client" module', () => {
  const src = readFileSync(
    fileURLToPath(new URL("../theme.ts", import.meta.url)),
    "utf8",
  );
  const firstCode = src
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("//"));
  assert.ok(
    firstCode !== undefined && !/^["']use client["']/.test(firstCode),
    `theme.ts first statement is ${JSON.stringify(firstCode)}; it must not be a "use client" directive`,
  );
});
