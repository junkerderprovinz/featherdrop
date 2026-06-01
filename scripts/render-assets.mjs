// One-off asset renderer (run manually; @resvg/resvg-js is installed --no-save,
// not a project dependency). Produces:
//   .github/assets/featherdrop-banner.svg  — canonical README banner: a white
//                                            1600x500 card with the feather
//                                            centered, no text (house style guide)
//   .github/assets/featherdrop-banner.png  — rendered banner
//   .github/assets/icon.png                — 512x512 square template icon
// Placement is derived from the path's real bounding box, so the feather is
// centered correctly regardless of the glyph's internal offset.
//
// Usage:  npm install --no-save @resvg/resvg-js && node scripts/render-assets.mjs
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const ASSETS = new URL("../.github/assets/", import.meta.url);
const logoSvg = readFileSync(new URL("featherdrop-logo.svg", ASSETS), "utf8");

// Inner content (defs + path) without the outer <svg> wrapper, so we can re-wrap
// it in arbitrary viewBoxes.
const inner = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const round = (n) => Math.round(n * 100) / 100;

function wrap(minX, minY, vbW, vbH) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(minX)} ${round(minY)} ${round(vbW)} ${round(vbH)}" role="img" aria-label="featherdrop">${inner}</svg>\n`;
}

function renderPng(svg, widthPx) {
  return new Resvg(svg, {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "width", value: widthPx },
  })
    .render()
    .asPng();
}

// Real bounding box of the rendered feather.
const probe = new Resvg(logoSvg, { background: "rgba(0,0,0,0)" });
const bb = probe.getBBox();
if (!bb) throw new Error("could not compute bbox");
const { x, y, width: w, height: h } = bb;

// --- Banner: canonical 1600x500 white card, feather centered, no text
//     (house style guide: white #ffffff background, logo only). ---
const BW = 1600;
const BH = 500;
const s = (BH * 0.78) / h; // fit the feather to ~78% of the banner height
const tx = (BW - w * s) / 2 - x * s; // center the bbox horizontally
const ty = (BH - h * s) / 2 - y * s; // center the bbox vertically
const bannerSvg =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BW} ${BH}" width="${BW}" height="${BH}" role="img" aria-label="featherdrop">\n` +
  `  <rect width="${BW}" height="${BH}" fill="#ffffff"/>\n` +
  `  <g transform="translate(${round(tx)},${round(ty)}) scale(${round(s)})">${inner}</g>\n` +
  `</svg>\n`;
writeFileSync(new URL("featherdrop-banner.svg", ASSETS), bannerSvg);
writeFileSync(new URL("featherdrop-banner.png", ASSETS), renderPng(bannerSvg, BW));

// --- Icon: square, feather centered with 10% padding, 512x512 ---
const side = Math.max(w, h) * 1.2;
const iconSvg = wrap(x - (side - w) / 2, y - (side - h) / 2, side, side);
writeFileSync(new URL("icon.png", ASSETS), renderPng(iconSvg, 512));

console.log(`bbox x=${round(x)} y=${round(y)} w=${round(w)} h=${round(h)}`);
console.log(`banner ${BW}x${BH} white, feather scale=${round(s)} -> ${BW}px png`);
console.log("wrote featherdrop-banner.svg, featherdrop-banner.png, icon.png");
