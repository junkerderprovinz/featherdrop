/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // better-sqlite3 is a native module used only in server code; keep it
    // external so webpack never bundles the .node binary (which would break it).
    // On Next 14 this is the experimental key; it became the stable top-level
    // `serverExternalPackages` only in Next 15.
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

export default nextConfig;
