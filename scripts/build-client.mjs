// Populate server-go/webroot/ with the built Vite SPA so `go build` (which
// embeds webroot via //go:embed) ships the real client.
//
// Run AFTER `npm run build:client` (which emits client-dist/). This script:
//   1. removes any previously-built asset dir under webroot (webroot/assets),
//      so a rebuild can't leave stale chunks behind (the committed placeholder
//      webroot/index.html and webroot/opengraph-image.png are left in place);
//   2. copies every file from client-dist/* into server-go/webroot/* — including
//      the built index.html, which STILL carries the %%TOKEN%% markers (Vite
//      leaves that text untouched) so the Go server's startup templating works;
//   3. copies app/opengraph-image.png to server-go/webroot/opengraph-image.png
//      (the app's own OG card, served by the Go static handler).
//
// Note on git: webroot/index.html is the COMMITTED token placeholder and the
// built assets under webroot/ are gitignored. CI/Docker runs `npm run build:spa`
// to fill webroot before `go build`; a local build can restore the placeholder
// index.html afterwards (it is byte-identical to the built one's <head>).
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
    `build:webroot: ${clientDist} not found — run "npm run build:client" first.`,
  );
  process.exit(1);
}

mkdirSync(webroot, { recursive: true });

// 1. Drop the previously-built asset dir so stale hashed chunks don't linger.
const builtAssets = join(webroot, "assets");
if (existsSync(builtAssets)) {
  rmSync(builtAssets, { recursive: true, force: true });
}

// 2. Copy client-dist/* into webroot/* (recursively, overwriting).
for (const entry of readdirSync(clientDist)) {
  const src = join(clientDist, entry);
  const dest = join(webroot, entry);
  cpSync(src, dest, { recursive: true });
}

// 3. Copy the OG card (resolves the Phase-4b deferred asset).
if (existsSync(ogSrc)) {
  cpSync(ogSrc, ogDest);
} else {
  console.warn(`build:webroot: ${ogSrc} not found — skipping OG image copy.`);
}

const count = readdirSync(webroot).filter((f) =>
  statSync(join(webroot, f)).isFile() || statSync(join(webroot, f)).isDirectory(),
).length;
console.log(
  `build:webroot: copied SPA into server-go/webroot/ (${count} top-level entries) + opengraph-image.png`,
);
