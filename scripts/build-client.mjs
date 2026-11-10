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
import { completeLicenses, sectionsWithoutText } from "./third-party-licenses.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDist = join(repoRoot, "client-dist");
const webroot = join(repoRoot, "server-go", "webroot");

if (!existsSync(clientDist)) {
  console.error(
    `build:webroot: ${clientDist} not found; run "npm run build:client" first.`,
  );
  process.exit(1);
}

rmSync(webroot, { recursive: true, force: true });
mkdirSync(webroot, { recursive: true });
cpSync(clientDist, webroot, { recursive: true });

const files = readdirSync(webroot, { recursive: true })
  .map(String)
  .filter((rel) => statSync(join(webroot, rel)).isFile())
  .map((rel) => rel.split(sep).join("/"));
const read = (path) => (files.includes(path) ? readFileSync(join(webroot, path)) : undefined);

const pkg = (name) => JSON.parse(readFileSync(join(repoRoot, "node_modules", name, "package.json"), "utf8"));
const licensed = (name, text) => ({ name, version: pkg(name).version, license: pkg(name).license, text });
const licensesPath = join(webroot, "third-party-licenses.md");
const kept = (file) => readFileSync(join(repoRoot, "scripts", "licenses", file), "utf8");
const shipped = (name) => readFileSync(join(repoRoot, "node_modules", name, "LICENSE"), "utf8");
// The worker's libsodium, and the packages that ship no LICENSE file, with the text from their repository.
const licenses = completeLicenses(readFileSync(licensesPath, "utf8"), [
  licensed("@glimstone/core", kept("glimstone.txt")),
  licensed("@glimstone/vue", kept("glimstone.txt")),
  licensed("@rive-app/canvas-lite", kept("rive-app-canvas-lite.txt")),
  licensed("qrcode-generator", kept("qrcode-generator.txt")),
  licensed("libsodium-sumo", shipped("libsodium-sumo")),
  licensed("libsodium-wrappers-sumo", shipped("libsodium-wrappers-sumo")),
]);
const unlicensed = sectionsWithoutText(licenses);
if (unlicensed.length) {
  console.error(`build:webroot: no license text for ${unlicensed.join(", ")} in third-party-licenses.md`);
  process.exit(1);
}
writeFileSync(licensesPath, licenses);

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
