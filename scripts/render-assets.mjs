// One-off asset renderer (run manually; @resvg/resvg-js + opentype.js come from
// the GLOBAL npm root, not project dependencies). Produces:
//   .github/assets/featherdrop-banner.svg  — canonical README banner: a white
//                                            1600x500 card, feather on the left,
//                                            "featherdrop" in Bitter Italic (the
//                                            app wordmark) + a claim below (house
//                                            banner convention, as on BombVault)
//   .github/assets/featherdrop-banner.png  — rendered banner
//   .github/assets/icon.png                — 512x512 square template icon
//   app/opengraph-image.png                — 1200x630 social/link-preview card
//   app/twitter-image.png                  — same card, for Twitter/X
// Placement is derived from the path's real bounding box, so the feather is
// positioned correctly regardless of the glyph's internal offset. The banner
// text is converted to SVG paths (opentype.js) so the SVG is self-contained —
// the Bitter (OFL) variable fonts are fetched at runtime to the OS temp dir and
// are NOT committed to the repo.
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

// Bitter (OFL) — the app's wordmark font. Italic 500 carries the wordmark
// (matching the app's fw=500), upright 400 carries the claim.
// NOTE: the google/fonts repo only ships Bitter as a VARIABLE font, and
// opentype.js ignores gvar deltas — it would render the thinnest master as
// hairline outlines. So fetch STATIC single-weight instances via the Google
// Fonts CSS API instead: a legacy User-Agent makes it return plain TTF URLs.
async function loadFont(spec, cacheName) {
  const path = join(tmpdir(), `featherdrop-${cacheName}.ttf`);
  if (!existsSync(path)) {
    const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${spec}`, {
      headers: { "User-Agent": "curl/8" }, // legacy UA → static TTF, no subsets
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

// --- Banner: canonical 1600x500 white card — feather on the left, the
//     "featherdrop" wordmark (Bitter Italic, the app's wordmark style incl. its
//     negative letter-spacing, filled with the logo's gold gradient) and a grey
//     claim below it (house banner convention, as on BombVault). ---
const BW = 1600;
const BH = 500;
const NAME = "featherdrop";
const CLAIM = "Drop it like it's hot.";
const CLAIM_FILL = "#5a5d5e"; // house claim grey (BombVault banner)
// The app wordmark uses letterSpacing -1px at 32px → -0.03125 em.
const NAME_SPACING = -0.031;

const LH = 410; // feather height (by real bbox)
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
// Keep the whole group inside the card with breathing room; shrink text if needed.
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
  // Same gold ramp as the feather (fd-gold), respanned vertically across the
  // wordmark's em box so the gradient runs top-light → bottom-dark on the text.
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

// --- Icon: square, feather centered with 10% padding, 512x512, on a solid
//     #121212 background so the Community Applications tile matches Unraid's dark
//     theme (this PNG is the CA <Icon>; the favicon and in-app logo stay
//     transparent/gradient and are unaffected). ---
const side = Math.max(w, h) * 1.2;
const iconSvg = wrap(x - (side - w) / 2, y - (side - h) / 2, side, side);
writeFileSync(
  new URL("icon.png", ASSETS),
  new Resvg(iconSvg, { background: "#121212", fitTo: { mode: "width", value: 512 } })
    .render()
    .asPng(),
);

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
