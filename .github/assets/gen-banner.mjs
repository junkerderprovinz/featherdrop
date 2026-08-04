/**
 * Generates the featherdrop README banner pair (theme-adaptive, 1600x500):
 *
 *   featherdrop-banner.svg / .png       light: white bg, gold feather + wordmark,
 *                                       grey claim            (README, light mode)
 *   featherdrop-banner-dark.svg / .png  dark: #0d1117 bg, the SAME gold feather +
 *                                       wordmark, light claim (README, dark mode)
 *
 * The feather + wordmark are hand-tuned art and live verbatim in the canonical
 * featherdrop-banner.svg — this script never redraws them. It (re)generates the
 * CLAIM, set in Lato (the shared claim font across the Bree-Serif/Bitter repos),
 * converted to SVG paths (opentype.js) so the SVG needs NO font and renders
 * identically with resvg or a browser. The dark variant is derived from the light
 * SVG by swapping ONLY the background and claim colours — the gold gradient reads
 * on both backgrounds, so the feather and wordmark stay byte-for-byte identical.
 *
 * featherdrop-banner-logo.svg/.png (textless support-thread banner) is NOT
 * touched by this script.
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
// Measured from the original banner so the claim keeps its left edge (x=638) and
// baseline: pen origin x / baseline y for opentype.getPath at claimSize 44.
const textX = 633.974, claimBaseline = 364.406;
// Theme pair (house rule): the canonical light SVG carries the light colours; the
// dark variant swaps ONLY bg + claim (feather + wordmark keep their gold gradient).
const LIGHT = { bg: "#ffffff", claim: "#5a5d5e" };
const DARK = { bg: "#0d1117", claim: "#9aa4ad" };
// ---------------------------------------------------------------------------

const latoPath = join(tmpdir(), "featherdrop-Lato-Regular.ttf");
if (!existsSync(latoPath)) {
  const r = await fetch("https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf");
  if (!r.ok) throw new Error(`Lato fetch ${r.status}`);
  writeFileSync(latoPath, Buffer.from(await r.arrayBuffer()));
}
const lato = opentype.parse(readFileSync(latoPath));
const claimPathData = lato.getPath(CLAIM, textX, claimBaseline, claimSize).toPathData(2);

// Replace exactly one occurrence; anything else means the canonical SVG drifted.
function swapOnce(svg, re, replacement, what) {
  const matches = svg.match(new RegExp(re, "g")) || [];
  if (matches.length !== 1) throw new Error(`expected exactly one ${what}, found ${matches.length}`);
  return svg.replace(re, replacement);
}

function emit(name, svg, bg) {
  writeFileSync(join(__dir, `${name}.svg`), svg);
  const png = new Resvg(svg, { background: bg, fitTo: { mode: "width", value: W } }).render().asPng();
  writeFileSync(join(__dir, `${name}.png`), png);
  console.log(`wrote ${name}.svg + .png`);
}

// Light: swap only the grey claim path in the canonical SVG; feather + wordmark
// stay byte-for-byte.
const lightSvg = swapOnce(
  readFileSync(svgPath, "utf8"),
  /<path d="[^"]+" fill="#5a5d5e"\/>/,
  `<path d="${claimPathData}" fill="${LIGHT.claim}"/>`,
  "claim path (fill #5a5d5e)",
);
emit("featherdrop-banner", lightSvg, LIGHT.bg);

// Dark: derived from the light SVG — background + claim colour only.
let darkSvg = swapOnce(lightSvg, /fill="#ffffff"/, `fill="${DARK.bg}"`, "background fill");
darkSvg = swapOnce(darkSvg, /fill="#5a5d5e"/, `fill="${DARK.claim}"`, "claim fill");
// Wordmark = foreground colour (was a gold gradient); flip it light on the dark banner.
darkSvg = swapOnce(darkSvg, /fill="#1f2328"/, `fill="#e6edf3"`, "wordmark fill");
emit("featherdrop-banner-dark", darkSvg, DARK.bg);

console.log(`claim: "${CLAIM}"`);
