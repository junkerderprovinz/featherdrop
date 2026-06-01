import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression guard for the v3.0.1 hotfix.
//
// theme.ts exports createAppTheme(), which is CALLED from the server component
// app/layout.tsx. If theme.ts is marked "use client", that export becomes a
// non-callable client reference on the server, so every page render throws
// "TypeError: u is not a function" during RSC serialization (HTTP 500 on every
// route). Theme creation is pure data, so the module must stay isomorphic.
test('theme.ts must NOT be a client module (createAppTheme is server-called)', () => {
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
    `theme.ts first statement is ${JSON.stringify(firstCode)} — it must not be a "use client" directive`,
  );
});
