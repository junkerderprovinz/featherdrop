// An esbuild plugin for the browser tests that handles "?worker&inline"
// imports as Vite does in the client build: the worker is bundled into a
// string and started from a blob: URL.
import { build } from "esbuild";

const QUERY = /\?worker&inline$/;

export const inlineWorker = {
  name: "inline-worker",
  setup(b) {
    b.onResolve({ filter: QUERY }, async (args) => {
      const r = await b.resolve(args.path.replace(QUERY, ""), { resolveDir: args.resolveDir, kind: args.kind });
      return { path: r.path, namespace: "inline-worker" };
    });
    b.onLoad({ filter: /.*/, namespace: "inline-worker" }, async (args) => {
      const out = await build({ entryPoints: [args.path], bundle: true, format: "esm", platform: "browser", write: false });
      return {
        loader: "js",
        contents: `
          const code = ${JSON.stringify(out.outputFiles[0].text)};
          export default function WorkerWrapper() {
            return new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })), { type: "module" });
          }
        `,
      };
    });
  },
};
