// One-off asset renderer (run manually; @resvg/resvg-js is installed --no-save,
// not a project dependency). Produces:
//   .github/assets/featherdrop-banner.svg  — logo-only emblem (no text), the
//                                            feather tightly cropped at its
//                                            natural aspect with a little padding
//   .github/assets/featherdrop-banner.png  — rendered emblem
//   .github/assets/icon.png                — 512x512 square template icon
// Both crops are derived from the path's real bounding box, so the feather is
// framed correctly regardless of the glyph's internal offset.
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

// --- Banner emblem: the feather tightly cropped at its natural aspect, with
//     ~8% padding all round so the strokes never touch the edge. ---
const pad = Math.max(w, h) * 0.08;
const emblemSvg = wrap(x - pad, y - pad, w + pad * 2, h + pad * 2);
writeFileSync(new URL("featherdrop-banner.svg", ASSETS), emblemSvg);
writeFileSync(new URL("featherdrop-banner.png", ASSETS), renderPng(emblemSvg, 600));

// --- Icon: square, feather centered with 10% padding, 512x512 ---
const side = Math.max(w, h) * 1.2;
const iconSvg = wrap(x - (side - w) / 2, y - (side - h) / 2, side, side);
writeFileSync(new URL("icon.png", ASSETS), renderPng(iconSvg, 512));

console.log(`bbox x=${round(x)} y=${round(y)} w=${round(w)} h=${round(h)}`);
console.log(`emblem ${round(w + pad * 2)}x${round(h + pad * 2)} -> 600px png`);
console.log("wrote featherdrop-banner.svg, featherdrop-banner.png, icon.png");
