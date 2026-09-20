// Copies the Vite build into server-go/webroot so `go build`, which embeds
// webroot, ships the real client. Run after `npm run build:client`.
//
// The built index.html keeps its %%TOKEN%% markers, which Vite leaves alone, so
// the server can template it at startup. The committed webroot/index.html is
// that same placeholder and the built assets are gitignored; a local build can
// restore the placeholder afterwards.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDist = join(repoRoot, "client-dist");
const webroot = join(repoRoot, "server-go", "webroot");
const ogSrc = join(repoRoot, "app", "opengraph-image.png");
const ogDest = join(webroot, "opengraph-image.png");

if (!existsSync(clientDist)) {
  console.error(
    `build:webroot: ${clientDist} not found; run "npm run build:client" first.`,
  );
  process.exit(1);
}

mkdirSync(webroot, { recursive: true });

// Otherwise stale hashed chunks from an earlier build would linger.
const builtAssets = join(webroot, "assets");
if (existsSync(builtAssets)) {
  rmSync(builtAssets, { recursive: true, force: true });
}

for (const entry of readdirSync(clientDist)) {
  const src = join(clientDist, entry);
  const dest = join(webroot, entry);
  cpSync(src, dest, { recursive: true });
}

if (existsSync(ogSrc)) {
  cpSync(ogSrc, ogDest);
} else {
  console.warn(`build:webroot: ${ogSrc} not found; skipping the OG image.`);
}

const count = readdirSync(webroot).filter((f) =>
  statSync(join(webroot, f)).isFile() || statSync(join(webroot, f)).isDirectory(),
).length;
console.log(
  `build:webroot: copied SPA into server-go/webroot/ (${count} top-level entries) + opengraph-image.png`,
);
