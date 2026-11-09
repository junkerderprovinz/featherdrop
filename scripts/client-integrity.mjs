// Adds Subresource Integrity to the built index.html. The browser then runs a
// script or applies a stylesheet only when its bytes hash to the value the
// shell names, so the shell's hash in the release manifest covers the code.
import { createHash } from "node:crypto";

const sri = (data) => "sha384-" + createHash("sha384").update(data).digest("base64");

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/**
 * @param {string} html the built index.html
 * @param {string[]} assetPaths every built file, relative to the webroot
 * @param {(path: string) => Uint8Array | undefined} read bytes of a built file
 */
export function addIntegrity(html, assetPaths, read) {
  const pinned = new Set();

  const pin = (tag, url) => {
    const path = url.replace(/^\//, "");
    const data = read(path);
    if (data === undefined) {
      throw new Error(`index.html loads ${url}, which is not in the build`);
    }
    pinned.add(path);
    return tag.replace(/\s*\/?>$/, (end) => ` integrity="${sri(data)}"${end}`);
  };

  const out = html.replace(/<(script|link)\b[^>]*>/g, (tag, name) => {
    if (name === "script") {
      const src = attr(tag, "src");
      if (src === undefined) {
        throw new Error(`index.html has an inline script, which no hash could pin: ${tag}`);
      }
      return pin(tag, src);
    }
    const rel = attr(tag, "rel");
    if (rel !== "stylesheet" && rel !== "modulepreload") return tag;
    return pin(tag, attr(tag, "href") ?? "");
  });

  // A chunk that arrives through import() carries no integrity, and a
  // modulepreload with one does not help: when its check fails, the later
  // import() fetches the URL again and runs whatever comes back. Vite keeps
  // the client in one chunk (vite.config.ts), and this keeps it that way.
  const unpinned = assetPaths.filter(
    (p) => p.startsWith("assets/") && /\.(js|css)$/.test(p) && !pinned.has(p),
  );
  if (unpinned.length > 0) {
    throw new Error(
      `index.html does not load ${unpinned.join(", ")}, so no integrity attribute covers it`,
    );
  }
  return out;
}
