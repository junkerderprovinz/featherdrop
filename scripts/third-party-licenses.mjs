// Vite writes the licenses of what it bundles into the main chunk. It cannot
// see the crypto worker, which is bundled on its own and travels as a string,
// and a package without a LICENSE file gets a heading and no text. The build
// fills both in and stops on any heading still without a text.

const heading = (p) => `## ${p.name} - ${p.version} (${p.license})`;

/**
 * Puts each package's text under its heading, adding the heading at the end when Vite did not list it.
 * @param {string} md Vite's license file
 * @param {{ name: string, version: string, license: string, text: string }[]} packages
 */
export function completeLicenses(md, packages) {
  let out = md;
  for (const p of packages) {
    const text = p.text.trim() + "\n";
    const at = out.indexOf(heading(p) + "\n");
    if (at === -1) {
      out = out.trimEnd() + "\n\n" + heading(p) + "\n\n" + text;
      continue;
    }
    const after = at + heading(p).length + 1;
    const next = out.indexOf("\n## ", after);
    const body = out.slice(after, next === -1 ? out.length : next);
    if (body.trim()) continue;
    out = out.slice(0, after) + "\n" + text + (next === -1 ? "" : "\n") + out.slice(next === -1 ? out.length : next + 1);
  }
  return out;
}

/** The headings, without "## ", that have no license text under them. */
export function sectionsWithoutText(md) {
  return md
    .split(/\n(?=## )/)
    .filter((part) => part.startsWith("## "))
    .filter((part) => !part.slice(part.indexOf("\n") + 1).trim())
    .map((part) => part.split("\n")[0].slice(3));
}
