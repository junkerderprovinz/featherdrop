/**
 * Generates the theme-adaptive README banner pair at 1600x500:
 *
 *   featherdrop-banner.svg / .png       light: white background, grey claim
 *   featherdrop-banner-dark.svg / .png  dark: #0d1117 background, light claim
 *
 * The feather and wordmark are hand-tuned art kept in featherdrop-banner.svg;
 * this script never redraws them. It only sets the claim in Lato, the claim
 * font shared across the house banners, as SVG paths so the file needs no font.
 * The dark variant swaps the background, claim and wordmark colours of the
 * light one. featherdrop-banner-logo.svg is left alone.
 *
 * Needs opentype.js and @resvg/resvg-js installed globally; Lato is downloaded
 * to the OS temp dir. To change the claim, edit CLAIM and run
 * `node .github/assets/gen-banner.mjs`.
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

const CLAIM = "Big files, zero baggage.";
const W = 1600;
const claimSize = 44;
// Pen origin and baseline that keep the claim's left edge at x=638.
const textX = 633.974, claimBaseline = 364.406;
const LIGHT = { bg: "#ffffff", claim: "#5a5d5e" };
const DARK = { bg: "#0d1117", claim: "#9aa4ad" };

const latoPath = join(tmpdir(), "featherdrop-Lato-Regular.ttf");
if (!existsSync(latoPath)) {
  const r = await fetch("https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf");
  if (!r.ok) throw new Error(`Lato fetch ${r.status}`);
  writeFileSync(latoPath, Buffer.from(await r.arrayBuffer()));
}
const lato = opentype.parse(readFileSync(latoPath));
const claimPathData = lato.getPath(CLAIM, textX, claimBaseline, claimSize).toPathData(2);

// Any count other than one means the canonical SVG has changed shape.
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

const lightSvg = swapOnce(
  readFileSync(svgPath, "utf8"),
  /<path d="[^"]+" fill="#5a5d5e"\/>/,
  `<path d="${claimPathData}" fill="${LIGHT.claim}"/>`,
  "claim path (fill #5a5d5e)",
);
emit("featherdrop-banner", lightSvg, LIGHT.bg);

let darkSvg = swapOnce(lightSvg, /fill="#ffffff"/, `fill="${DARK.bg}"`, "background fill");
darkSvg = swapOnce(darkSvg, /fill="#5a5d5e"/, `fill="${DARK.claim}"`, "claim fill");
// The dark wordmark would disappear on the dark background.
darkSvg = swapOnce(darkSvg, /fill="#1f2328"/, `fill="#e6edf3"`, "wordmark fill");
emit("featherdrop-banner-dark", darkSvg, DARK.bg);

console.log(`claim: "${CLAIM}"`);
