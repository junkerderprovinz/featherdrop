import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Decoupled Vite SPA that REUSES the existing React app (components/, lib/, app/)
// so the Go backend can embed + serve it as static assets. The Next.js app keeps
// working unchanged — Next ignores this file, and this build never touches the
// Next config or the existing sources (only the aliases below redirect imports).
//
// Aliases:
//   "@"        -> repo root, so the components' "@/components", "@/lib", "@/app",
//                 "@/theme" path imports resolve exactly as they do under Next
//                 (tsconfig paths "@/*": ["./*"]).
//   "next/link" -> src/shims/next-link.tsx, the ONLY next-specific import in the
//                 component tree (DownloadView/ManageView), rendered via
//                 react-router-dom in the SPA.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: [
      // Most specific first: redirect next/link before the generic "@" mapping.
      {
        find: "next/link",
        replacement: fileURLToPath(
          new URL("./src/shims/next-link.tsx", import.meta.url),
        ),
      },
      // "@/x" -> "<repoRoot>/x". A trailing-slash-aware regex so "@/components"
      // maps to "<repoRoot>/components" (and never collides with a bare "@").
      { find: /^@\//, replacement: `${repoRoot}/` },
    ],
  },
  // The repo's postcss.config.cjs (postcss-preset-mantine + postcss-simple-vars)
  // exists ONLY for Next's Mantine CSS-module authoring; it is not needed at CSS
  // CONSUMPTION time (all imported CSS — Mantine, dropzone, notifications,
  // flag-icons, fontsource, globals.css — is plain/pre-compiled, and the app uses
  // no Mantine CSS-module mixins). Vite would otherwise auto-load that file and
  // run postcss-simple-vars over third-party CSS, which throws on the "$…" tokens
  // inside flag-icons.min.css. An empty inline config makes Vite skip the file
  // entirely without touching it (Next still uses it).
  css: {
    postcss: {},
  },
  build: {
    outDir: "client-dist",
    emptyOutDir: true,
  },
});
