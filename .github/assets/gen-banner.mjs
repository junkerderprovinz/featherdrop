/**
 * Generates the featherdrop README banner:
 *   featherdrop-banner.svg / .png : white 1600x500; the gold feather mark on the
 *   left, the "featherdrop" wordmark (Bitter Italic 500, gold gradient) to the
 *   right, and a claim below it. The feather + wordmark are hand-tuned art and
 *   live verbatim in the SVG — this script only (re)generates the CLAIM, set in
 *   Lato (the shared claim font across the Bree-Serif/Bitter repos). The claim is
 *   converted to SVG paths (opentype.js) so the SVG needs NO font and renders
 *   identically with resvg or a browser.
 *
 * Deps (global): opentype.js, @resvg/resvg-js. Lato (OFL) is fetched at runtime
 * to the OS temp dir — NOT committed.
 *
 * To change the claim: edit CLAIM below and run `node .github/assets/gen-banner.mjs`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const groot = execSync("npm root -g").toString().trim();
const opentype = require(`${groot}/opentype.js`);
const { Resvg } = require(`${groot}/@resvg/resvg-js`);

const __dir = dirname(fileURLToPath(import.meta.url));
const svgPath = join(__dir, "featherdrop-banner.svg");

// ---- content + styling -----------------------------------------------------
const CLAIM = "Big files, zero baggage.";
const W = 1600;
const claimSize = 44;
const claimFill = "#5a5d5e";
// Measured from the original banner so the claim keeps its left edge (x=638) and
// baseline: pen origin x / baseline y for opentype.getPath at claimSize 44.
const textX = 633.974, claimBaseline = 364.406;
// ---------------------------------------------------------------------------

const latoPath = join(tmpdir(), "featherdrop-Lato-Regular.ttf");
if (!existsSync(latoPath)) {
  const r = await fetch("https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf");
  if (!r.ok) throw new Error(`Lato fetch ${r.status}`);
  writeFileSync(latoPath, Buffer.from(await r.arrayBuffer()));
}
const lato = opentype.parse(readFileSync(latoPath));
const claimPath = lato.getPath(CLAIM, textX, claimBaseline, claimSize).toPathData(2);

// Swap only the grey claim path; the feather + wordmark stay byte-for-byte.
const svg = readFileSync(svgPath, "utf8");
const re = /<path d="[^"]+" fill="#5a5d5e"\/>/;
if (!re.test(svg)) throw new Error("claim path (fill #5a5d5e) not found in SVG");
const out = svg.replace(re, `<path d="${claimPath}" fill="${claimFill}"/>`);
writeFileSync(svgPath, out);

const png = new Resvg(out, { background: "#ffffff", fitTo: { mode: "width", value: W } }).render().asPng();
writeFileSync(join(__dir, "featherdrop-banner.png"), png);
console.log(`wrote featherdrop-banner.svg + .png — claim: "${CLAIM}"`);
