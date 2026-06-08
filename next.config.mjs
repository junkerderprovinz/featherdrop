/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained .next/standalone with a trace-pruned node_modules
  // (~24MB vs ~498MB). The custom server feeds Next the pre-resolved config so
  // it never loads the (pruned) webpack machinery — see custom-server.ts.
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
