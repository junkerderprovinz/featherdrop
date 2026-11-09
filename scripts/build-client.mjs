// Copies the Vite build into server-go/webroot so `go build`, which embeds
// webroot, ships the real client. Run after `npm run build:client`.
//
// The built index.html keeps its %%TOKEN%% markers, which Vite leaves alone, so
// the server can template it at startup. Every script and stylesheet it loads
// gets an integrity attribute here. The committed webroot/index.html is that
// same placeholder and the built assets are gitignored; a local build can
// restore the placeholder afterwards.
//
// The webroot is rebuilt from nothing, so its bytes depend on the commit
// alone and scripts/client-manifest.mjs hashes the same files on any machine.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addIntegrity } from "./client-integrity.mjs";
import { checkSodiumOnce, sodiumWasm } from "./sodium-once.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDist = join(repoRoot, "client-dist");
const webroot = join(repoRoot, "server-go", "webroot");
const ogSrc = join(repoRoot, "app", "opengraph-image.png");

if (!existsSync(clientDist)) {
  console.error(
    `build:webroot: ${clientDist} not found; run "npm run build:client" first.`,
  );
  process.exit(1);
}
if (!existsSync(ogSrc)) {
  console.error(`build:webroot: ${ogSrc} not found.`);
  process.exit(1);
}

rmSync(webroot, { recursive: true, force: true });
mkdirSync(webroot, { recursive: true });
cpSync(clientDist, webroot, { recursive: true });
cpSync(ogSrc, join(webroot, "opengraph-image.png"));

const files = readdirSync(webroot, { recursive: true })
  .map(String)
  .filter((rel) => statSync(join(webroot, rel)).isFile())
  .map((rel) => rel.split(sep).join("/"));
const read = (path) => (files.includes(path) ? readFileSync(join(webroot, path)) : undefined);

const indexPath = join(webroot, "index.html");
writeFileSync(indexPath, addIntegrity(readFileSync(indexPath, "utf8"), files, read));

const sodium = join(repoRoot, "node_modules", "libsodium-sumo", "dist", "modules-sumo-esm", "libsodium-sumo.mjs");
const scripts = files.filter((p) => p.startsWith("assets/") && p.endsWith(".js"));
try {
  checkSodiumOnce(
    scripts.map((path) => ({ path, text: readFileSync(join(webroot, path), "utf8") })),
    sodiumWasm(readFileSync(sodium, "utf8")),
  );
} catch (err) {
  console.error(`build:webroot: ${err.message}`);
  process.exit(1);
}

console.log(
  `build:webroot: wrote ${files.length} files to server-go/webroot/, index.html pinned with SRI, libsodium once`,
);
