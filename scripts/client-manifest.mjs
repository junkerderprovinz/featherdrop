// Hashes the built client into the manifest a release carries. The Go server
// (server-go/internal/clientmanifest) builds the same bytes from the files its
// binary embeds, so a release and a running instance compare directly.
//
// Usage: node scripts/client-manifest.mjs [--out FILE] [WEBROOT]
// WEBROOT defaults to server-go/webroot, and without --out the manifest goes to
// stdout.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORMAT = "castleparcel-client/1";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Paths sort by their UTF-8 bytes, as Go compares strings.
const byPath = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));

/**
 * The root is the SHA-256 of the lines sha256sum prints for the files, so
 * coreutils alone can recompute it.
 * @param {{path: string, sha256: string}[]} files sorted by path
 */
export function rootOf(files) {
  return sha256(files.map((f) => `${f.sha256}  ${f.path}\n`).join(""));
}

/** @param {[string, Uint8Array][]} entries path and bytes of every file */
export function manifestFromFiles(entries) {
  const files = entries
    .map(([path, data]) => ({ path, sha256: sha256(data) }))
    .sort(byPath);
  return { format: FORMAT, root: rootOf(files), files };
}

/** @param {string} dir */
export function buildManifest(dir) {
  const entries = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => [rel.split(sep).join("/"), readFileSync(join(dir, rel))]);
  return manifestFromFiles(entries);
}

/** Two-space JSON with a final newline, the layout Go's encoder writes. */
export function manifestJSON(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt === -1 ? undefined : args.splice(outAt, 2)[1];
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const json = manifestJSON(buildManifest(args[0] ?? join(repoRoot, "server-go", "webroot")));
  if (out) {
    writeFileSync(out, json);
  } else {
    process.stdout.write(json);
  }
}
