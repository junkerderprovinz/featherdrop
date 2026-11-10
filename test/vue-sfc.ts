// Lets the node tests load the client's single-file components: an esbuild
// plugin compiles a .vue file's script and template the way Vite does, and
// loadComponent bundles one component with the client modules it imports,
// leaving packages such as vue and GlimStone to node.
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { compileScript, parse } from "vue/compiler-sfc";
import type { Component } from "vue";

const root = join(import.meta.dirname, "..");

export const vueSfc: Plugin = {
  name: "vue-sfc",
  setup(b) {
    b.onLoad({ filter: /\.vue$/ }, async (args) => {
      const { descriptor } = parse(await readFile(args.path, "utf8"), { filename: args.path });
      const id = relative(root, args.path).replace(/\W/g, "");
      const script = compileScript(descriptor, { id, inlineTemplate: true });
      return { contents: script.content, loader: "ts", resolveDir: join(args.path, "..") };
    });
  },
};

// The client's own modules are bundled; every package stays a plain import,
// unless stubs names a module of the repo to take its place. A stub for a
// client module, keyed by its @/ path, is imported rather than bundled, so the
// test that imports it too shares its state with the component.
const ownModules = (stubs: Record<string, string>): Plugin => ({
  name: "own-modules",
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) =>
      stubs[args.path]
        ? { path: pathToFileURL(join(root, stubs[args.path])).href, external: true }
        : b.resolve("./" + args.path.slice(2), { resolveDir: root, kind: args.kind }),
    );
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      return stubs[args.path] ? { path: join(root, stubs[args.path]) } : { path: args.path, external: true };
    });
  },
});

/** Bundles a component of src/ and imports it. */
export async function loadComponent(path: string, stubs: Record<string, string> = {}): Promise<Component> {
  const out = join(root, "node_modules", ".cache", "vue-sfc", relative(root, path).replace(/\W/g, "_") + ".mjs");
  mkdirSync(join(out, ".."), { recursive: true });
  await build({
    entryPoints: [join(root, path)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: out,
    logLevel: "silent",
    plugins: [ownModules(stubs), vueSfc],
    loader: { ".css": "empty", ".svg": "empty", ".json": "json" },
  });
  return (await import(pathToFileURL(out).href)).default as Component;
}
