// Checks that a running instance serves exactly the client of a release. It
// fetches every file the release manifest lists from the instance, hashes it
// and compares. The page at / is the release's index.html with the instance's
// branding filled into its markers, so it is checked against that template:
// only escaped text may stand where a marker was.
//
// Usage: node scripts/verify-client.mjs INSTANCE_URL MANIFEST
// MANIFEST is a file or URL, such as the castleparcel-client.json attached to
// a GitHub release. Exits 0 when everything matches.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FORMAT, rootOf } from "./client-manifest.mjs";

const MANIFEST_PATH = "/.well-known/castleparcel-client.json";
const TEMPLATE_PATH = "/.well-known/castleparcel-client/index.html";

// html.EscapeString in Go leaves text without < > " ' and with & only in
// these entities.
const ESCAPED_TEXT = `(?:[^<>"'&]|&(?:amp|lt|gt|#39|#34);)*`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Reports whether served is template with escaped text in place of every %%MARKER%%. */
export function shellMatchesTemplate(template, served) {
  const pattern = template
    .split(/%%[A-Z_]+%%/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(ESCAPED_TEXT);
  return new RegExp(`^${pattern}$`).test(served);
}

/**
 * @param {{instance: string, manifest: {format: string, root: string, files: {path: string, sha256: string}[]},
 *   fetch?: typeof globalThis.fetch}} options
 * @returns {Promise<{root: string, checked: number, problems: string[]}>}
 */
export async function verifyClient({ instance, manifest, fetch = globalThis.fetch }) {
  if (manifest.format !== FORMAT) {
    throw new Error(`manifest format ${manifest.format}, this script reads ${FORMAT}`);
  }
  if (rootOf(manifest.files) !== manifest.root) {
    throw new Error("the manifest's root does not match its file list");
  }

  const problems = [];
  const get = async (path) => {
    const res = await fetch(new URL(path, instance), { redirect: "error" });
    if (!res.ok) {
      problems.push(`${path}: HTTP ${res.status}`);
      return undefined;
    }
    return Buffer.from(await res.arrayBuffer());
  };

  for (const file of manifest.files) {
    const url = "/" + file.path.split("/").map(encodeURIComponent).join("/");
    if (file.path === "index.html") {
      const template = await get(TEMPLATE_PATH);
      if (template === undefined) continue;
      if (sha256(template) !== file.sha256) {
        problems.push(`index.html: the template has sha256 ${sha256(template)}, the release lists ${file.sha256}`);
        continue;
      }
      const page = await get("/");
      if (page !== undefined && !shellMatchesTemplate(template.toString("utf8"), page.toString("utf8"))) {
        problems.push("index.html: the page at / is not the template with only branding filled in");
      }
      continue;
    }
    const data = await get(url);
    if (data !== undefined && sha256(data) !== file.sha256) {
      problems.push(`${file.path}: sha256 ${sha256(data)}, the release lists ${file.sha256}`);
    }
  }

  // Matching files alone could hide an extra one the release does not have.
  const reported = await get(MANIFEST_PATH);
  if (reported !== undefined) {
    const root = JSON.parse(reported.toString("utf8")).root;
    if (root !== manifest.root) {
      problems.push(`the instance reports client root ${root}, the release has ${manifest.root}`);
    }
  }

  return { root: manifest.root, checked: manifest.files.length, problems };
}

async function loadManifest(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [instance, source] = process.argv.slice(2);
  if (!instance || !source) {
    console.error("usage: node scripts/verify-client.mjs INSTANCE_URL MANIFEST");
    process.exit(2);
  }
  try {
    const result = await verifyClient({ instance, manifest: await loadManifest(source) });
    for (const problem of result.problems) console.error(`MISMATCH ${problem}`);
    if (result.problems.length > 0) {
      console.error(`${instance} does not serve the client with root ${result.root}.`);
      process.exit(1);
    }
    console.log(`${instance} serves all ${result.checked} files of the client with root ${result.root}.`);
  } catch (err) {
    console.error(`verify-client: ${err.message}`);
    process.exit(2);
  }
}
