import { test } from "node:test";
import assert from "node:assert/strict";
import { relative, sep } from "node:path";
import { build, type Plugin } from "esbuild";

// The crypto worker carries the one copy of libsodium the client ships. The
// page bundles the worker as a string, so an import of libsodium anywhere in
// the page's own graph would ship a second copy.
test("the page reaches libsodium only through the crypto worker", async () => {
  const importers = new Set<string>();
  const probe: Plugin = {
    name: "probe",
    setup(b) {
      b.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, external: true }));
      b.onResolve({ filter: /^libsodium/ }, (args) => {
        importers.add(relative(process.cwd(), args.importer).split(sep).join("/"));
        return { path: args.path, external: true };
      });
      // No other package imports libsodium, so the page's own modules are all
      // that needs walking.
      b.onResolve({ filter: /^[^.]/ }, (args) => {
        const own = args.kind === "entry-point" || args.path.startsWith("@/") || args.path === "next/link";
        return own ? undefined : { path: args.path, external: true };
      });
    },
  };
  await build({
    entryPoints: ["src/main.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
    plugins: [probe],
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".woff": "empty", ".woff2": "empty" },
  });

  assert.deepEqual([...importers], []);
});
