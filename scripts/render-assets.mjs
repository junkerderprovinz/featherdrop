// Renders the image assets, run by hand with @resvg/resvg-js and opentype.js
// from the global npm root:
//   .github/assets/featherdrop-banner.svg  README banner, a white 1600x500 card
//                                          with the feather, the wordmark in
//                                          Bitter Italic and a claim below
//   .github/assets/featherdrop-banner.png  the rendered banner
//   .github/assets/icon.png                512x512 template icon
//   app/opengraph-image.png                1200x630 link preview card
// The feather is placed by its real bounding box, whatever the path's own
// offset. The text becomes SVG paths so the SVG needs no font; Bitter is
// downloaded to the OS temp dir and not committed.
//
// Usage:  npm i -g @resvg/resvg-js opentype.js && node scripts/render-assets.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const gRoot = execSync("npm root -g").toString().trim();
const { Resvg } = require(`${gRoot}/@resvg/resvg-js`);
const opentype = require(`${gRoot}/opentype.js`);

const ASSETS = new URL("../.github/assets/", import.meta.url);
const logoSvg = readFileSync(new URL("featherdrop-logo.svg", ASSETS), "utf8");

// Bitter Italic 500 for the wordmark as in the app, upright 400 for the claim.
// google/fonts only ships Bitter as a variable font, and opentype.js ignores
// gvar deltas and would draw the thinnest master, so static instances come from
// the Google Fonts CSS API, which returns plain TTF URLs to a legacy User-Agent.
async function loadFont(spec, cacheName) {
  const path = join(tmpdir(), `featherdrop-${cacheName}.ttf`);
  if (!existsSync(path)) {
    const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${spec}`, {
      headers: { "User-Agent": "curl/8" },
    });
    if (!cssRes.ok) throw new Error(`font css ${spec}: ${cssRes.status}`);
    const css = await cssRes.text();
    const m = css.match(/url\((https:[^)]+\.ttf)\)/);
    if (!m) throw new Error(`no ttf url in css for ${spec}`);
    const ttf = await fetch(m[1]);
    if (!ttf.ok) throw new Error(`font ttf ${spec}: ${ttf.status}`);
    writeFileSync(path, Buffer.from(await ttf.arrayBuffer()));
  }
  const buf = readFileSync(path);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const bitterItalic = await loadFont("Bitter:ital,wght@1,500", "Bitter-Italic-500");
const bitterRegular = await loadFont("Bitter:wght@400", "Bitter-Regular-400");

// The logo without its <svg> wrapper, to re-wrap in other viewBoxes.
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

const probe = new Resvg(logoSvg, { background: "rgba(0,0,0,0)" });
const bb = probe.getBBox();
if (!bb) throw new Error("could not compute bbox");
const { x, y, width: w, height: h } = bb;

// The banner: the wordmark in the logo's gold with the app's negative letter
// spacing, and a grey claim below.
const BW = 1600;
const BH = 500;
const NAME = "featherdrop";
const CLAIM = "Drop it like it's hot.";
const CLAIM_FILL = "#5a5d5e"; // the house claim grey
// The app wordmark uses -1px letter spacing at 32px.
const NAME_SPACING = -0.031;

const LH = 410; // feather height by its bounding box
const s = LH / h;
const logoW = w * s;
let nameSize = 140;
let claimSize = 42;
const gap = 56;
const lineGap = 22;

const nameWidth = () =>
  bitterItalic.getAdvanceWidth(NAME, nameSize, { kerning: true, letterSpacing: NAME_SPACING });
const claimWidth = () =>
  bitterRegular.getAdvanceWidth(CLAIM, claimSize, { kerning: true });
// Shrinks the text until the group fits the card with some margin.
while (logoW + gap + Math.max(nameWidth(), claimWidth()) > BW - 120 && nameSize > 80) {
  nameSize -= 4;
  claimSize = Math.max(30, claimSize - 1);
}

const groupW = logoW + gap + Math.max(nameWidth(), claimWidth());
const startX = (BW - groupW) / 2;
const tx = startX - x * s;
const ty = (BH - LH) / 2 - y * s;
const bTextX = startX + logoW + gap;

const em = (f, size) => size / f.unitsPerEm;
const nameAsc = bitterItalic.ascender * em(bitterItalic, nameSize);
const nameDesc = -bitterItalic.descender * em(bitterItalic, nameSize);
const claimAsc = bitterRegular.ascender * em(bitterRegular, claimSize);
const blockH = nameAsc + nameDesc + lineGap + claimAsc;
const nameBaseline = BH / 2 - blockH / 2 + nameAsc;
const claimBaseline = nameBaseline + nameDesc + lineGap + claimAsc;

const namePath = bitterItalic
  .getPath(NAME, bTextX, nameBaseline, nameSize, { kerning: true, letterSpacing: NAME_SPACING })
  .toPathData(2);
const claimPath = bitterRegular
  .getPath(CLAIM, bTextX, claimBaseline, claimSize, { kerning: true })
  .toPathData(2);

const bannerSvg =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BW} ${BH}" width="${BW}" height="${BH}" role="img" aria-label="featherdrop">\n` +
  `  <defs>\n` +
  // The feather's gold ramp, spanned across the wordmark's em box so it runs
  // light to dark from top to bottom.
  `    <linearGradient id="fd-gold-name" x1="0" y1="${round(nameBaseline - nameAsc)}" x2="0" y2="${round(nameBaseline + nameDesc)}" gradientUnits="userSpaceOnUse">\n` +
  `      <stop offset="0" stop-color="#E0B53A"/>\n` +
  `      <stop offset="0.5" stop-color="#D4AF37"/>\n` +
  `      <stop offset="1" stop-color="#A97C0A"/>\n` +
  `    </linearGradient>\n` +
  `  </defs>\n` +
  `  <rect width="${BW}" height="${BH}" fill="#ffffff"/>\n` +
  `  <g transform="translate(${round(tx)},${round(ty)}) scale(${round(s)})">${inner}</g>\n` +
  `  <path d="${namePath}" fill="url(#fd-gold-name)"/>\n` +
  `  <path d="${claimPath}" fill="${CLAIM_FILL}"/>\n` +
  `</svg>\n`;
writeFileSync(new URL("featherdrop-banner.svg", ASSETS), bannerSvg);
writeFileSync(new URL("featherdrop-banner.png", ASSETS), renderPng(bannerSvg, BW));

// The icon is the Community Applications <Icon>, so its #121212 background
// matches Unraid's dark theme. The favicon and the in-app logo stay
// transparent.
const side = Math.max(w, h) * 1.2;
const iconSvg = wrap(x - (side - w) / 2, y - (side - h) / 2, side, side);
writeFileSync(
  new URL("icon.png", ASSETS),
  new Resvg(iconSvg, { background: "#121212", fitTo: { mode: "width", value: 512 } })
    .render()
    .asPng(),
);

// The link preview card is generic, never the file name. It uses a system
// serif and is rendered once and committed.
const OGW = 1600;
const OGH = (OGW * 630) / 1200; // the 1.91:1 OG aspect
const ogScale = (OGH * 0.58) / h;
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

console.log(`bbox x=${round(x)} y=${round(y)} w=${round(w)} h=${round(h)}`);
console.log(`banner ${BW}x${BH} white, feather scale=${round(s)} -> ${BW}px png`);
console.log(`og card 1200x630 (rendered @ ${OGW}px), medallion scale=${round(ogScale)}`);
console.log("wrote featherdrop-banner.svg, featherdrop-banner.png, icon.png,");
console.log("      app/opengraph-image.png");
