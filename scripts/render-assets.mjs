// One-off asset renderer (run manually; @resvg/resvg-js is installed --no-save,
// not a project dependency). Produces:
//   .github/assets/featherdrop-banner.svg  — canonical README banner: a white
//                                            1600x500 card with the feather
//                                            centered, no text (house style guide)
//   .github/assets/featherdrop-banner.png  — rendered banner
//   .github/assets/icon.png                — 512x512 square template icon
//   app/opengraph-image.png                — 1200x630 social/link-preview card
//   app/twitter-image.png                  — same card, for Twitter/X
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

// --- Social card: 1200x630 dark "aurora" card with the medallion on the left
//     and the wordmark + tagline on the right. Served by Next's
//     app/opengraph-image.png + app/twitter-image.png file convention, so a
//     shared link renders a branded preview (kept generic — never the filename).
//     Text uses a system serif; this card is rendered once and committed. ---
const OGW = 1600;
const OGH = (OGW * 630) / 1200; // keep the 1.91:1 OG aspect, render at 2x
const ogScale = (OGH * 0.58) / h; // medallion ~58% of card height
const ogLogoW = w * ogScale;
const ogLeftPad = OGW * 0.075;
const ogTx = ogLeftPad - x * ogScale;
const ogTy = (OGH - h * ogScale) / 2 - y * ogScale;
const textX = ogLeftPad + ogLogoW + OGW * 0.04;
const ogSvg =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${OGW} ${round(OGH)}" width="${OGW}" height="${round(OGH)}">\n` +
  `  <defs>\n` +
  `    <radialGradient id="og-gold" cx="10%" cy="-10%" r="75%"><stop offset="0" stop-color="#f6d981" stop-opacity="0.34"/><stop offset="55%" stop-color="#f6d981" stop-opacity="0"/></radialGradient>\n` +
  `    <radialGradient id="og-violet" cx="98%" cy="8%" r="80%"><stop offset="0" stop-color="#7c3aed" stop-opacity="0.32"/><stop offset="55%" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>\n` +
  `  </defs>\n` +
  `  <rect width="${OGW}" height="${round(OGH)}" fill="#0d0b07"/>\n` +
  `  <rect width="${OGW}" height="${round(OGH)}" fill="url(#og-gold)"/>\n` +
  `  <rect width="${OGW}" height="${round(OGH)}" fill="url(#og-violet)"/>\n` +
  `  <g transform="translate(${round(ogTx)},${round(ogTy)}) scale(${round(ogScale)})">${inner}</g>\n` +
  `  <text x="${round(textX)}" y="${round(OGH * 0.505)}" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-weight="700" font-size="${round(OGH * 0.15)}" fill="#e8c75a">featherdrop</text>\n` +
  `  <text x="${round(textX) + 4}" y="${round(OGH * 0.63)}" font-family="'Segoe UI', Arial, sans-serif" font-size="${round(OGH * 0.05)}" fill="#cfc4ad">Drop a file · share a link</text>\n` +
  `</svg>\n`;
const ogPng = renderPng(ogSvg, 1200);
writeFileSync(new URL("../../app/opengraph-image.png", ASSETS), ogPng);
writeFileSync(new URL("../../app/twitter-image.png", ASSETS), ogPng);

console.log(`bbox x=${round(x)} y=${round(y)} w=${round(w)} h=${round(h)}`);
console.log(`banner ${BW}x${BH} white, feather scale=${round(s)} -> ${BW}px png`);
console.log(`og card 1200x630 (rendered @ ${OGW}px), medallion scale=${round(ogScale)}`);
console.log("wrote featherdrop-banner.svg, featherdrop-banner.png, icon.png,");
console.log("      app/opengraph-image.png, app/twitter-image.png");
