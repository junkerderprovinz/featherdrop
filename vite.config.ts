import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Builds the Vue client in src/ and lib/ into the static SPA the Go server
// embeds. "@/x" resolves to the repo root as in tsconfig.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "/",
  resolve: {
    // Anchored on "@/" so a bare "@" package scope never matches.
    alias: [{ find: /^@\//, replacement: `${repoRoot}/` }],
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
