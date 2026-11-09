import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the React app in components/, lib/ and app/ into the static SPA the Go
// server embeds. "@/x" resolves to the repo root as in tsconfig, and next/link
// goes to a react-router shim.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: [
      // Before the generic "@" mapping.
      {
        find: "next/link",
        replacement: fileURLToPath(
          new URL("./src/shims/next-link.tsx", import.meta.url),
        ),
      },
      // Anchored on "@/" so a bare "@" package scope never matches.
      { find: /^@\//, replacement: `${repoRoot}/` },
    ],
  },
  // Vite would otherwise load postcss.config.cjs, whose postcss-simple-vars
  // throws on the "$" tokens in flag-icons.min.css. All imported CSS is
  // precompiled, so no PostCSS plugins are needed.
  css: {
    postcss: {},
  },
  build: {
    outDir: "client-dist",
    emptyOutDir: true,
    // index.html pins its scripts with integrity attributes, and a chunk
    // loaded by import() could not be pinned, so the client stays one chunk.
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
  // The crypto worker is imported with ?worker&inline, so its bundle lands in
  // the main chunk as a string and runs from a blob: URL under the main
  // chunk's integrity hash. It must be one chunk for the same reason, and an
  // ES module because libsodium uses top-level await.
  worker: {
    format: "es",
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
