/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle in .next/standalone with only the
  // modules actually traced as needed — keeps the runtime image small. The
  // custom server (custom-server.ts, bundled separately) is started instead of
  // Next's generated server.js, but it reuses standalone's traced node_modules.
  output: "standalone",
  experimental: {
    // better-sqlite3 is a native module used only in server code; keep it
    // external so webpack never bundles the .node binary (which would break it).
    // On Next 14 this is the experimental key; it became the stable top-level
    // `serverExternalPackages` only in Next 15.
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

export default nextConfig;
