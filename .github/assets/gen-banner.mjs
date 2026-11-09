/**
 * Generates the 1600x500 banners:
 *
 *   castleparcel-banner.svg/.png       light, logo, name and claim  (README)
 *   castleparcel-banner-dark.svg/.png  dark, logo, name and claim   (README, GitHub dark)
 *   castleparcel-banner-logo.svg/.png  light, logo only             (support thread)
 *
 * Both themes embed castleparcel-logo.svg, whose stone greys and gold read on either background.
 * CastleParcel has no wordmark font of its own, so the name is set in Bree Serif, the house font.
 * Text becomes SVG paths, so the SVG renders the same everywhere without the fonts.
 *
 * Deps (global): opentype.js, @resvg/resvg-js. Fonts are fetched to the OS temp dir.
 * Run: node .github/assets/gen-banner.mjs
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

const NAME = "CastleParcel";
const CLAIM = "Sealed in the keep. Only your link gets in.";
const LOGO = "castleparcel-logo.svg";
const W = 1600, H = 500;
const LH = 400, LW = 400;
// Sizes and gaps shared by the banners of all repos.
const claimSize = 44, gap = 70, lineGap = 8, margin = 60;

const THEMES = [
  { suffix: "", bg: "#ffffff", name: "#1f2328", claim: "#5a5d5e" },
  { suffix: "-dark", bg: "#0d1117", name: "#e6edf3", claim: "#9aa4ad" },
];

async function font(file, url) {
  const path = join(tmpdir(), file);
  if (!existsSync(path)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font fetch ${res.status}: ${url}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return opentype.parse(readFileSync(path));
}
const nameFont = await font("CastleParcel-BreeSerif-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/breeserif/BreeSerif-Regular.ttf");
const claimFont = await font("CastleParcel-Lato-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf");

// The shared name size is 132; a name too long for the row beside the logo is set smaller rather than run off.
const room = W - 2 * margin - LW - gap;
const nameSize = Math.min(132, Math.floor((132 * room) / nameFont.getAdvanceWidth(NAME, 132)));
const textW = Math.max(nameFont.getAdvanceWidth(NAME, nameSize), claimFont.getAdvanceWidth(CLAIM, claimSize));

// The logo is narrower than its box, so the group is centred on the drawn width and not on LW.
const vb = readFileSync(join(__dir, LOGO), "utf8").match(/viewBox="([^"]+)"/)[1].split(/[\s,]+/).map(Number);
const drawnW = (LH * vb[2]) / vb[3];
const startX = Math.round((W - (drawnW + gap + textW)) / 2);
const LX = startX - (LW - drawnW) / 2, LY = (H - LH) / 2;
const textX = startX + drawnW + gap;

const nameAsc = nameFont.ascender * (nameSize / nameFont.unitsPerEm);
const nameDesc = -nameFont.descender * (nameSize / nameFont.unitsPerEm);
const claimAsc = claimFont.ascender * (claimSize / claimFont.unitsPerEm);
const blockH = nameAsc + nameDesc + lineGap + claimAsc;
const nameBaseline = H / 2 - blockH / 2 + nameAsc;
const claimBaseline = nameBaseline + nameDesc + lineGap + claimAsc;

// Written from the commands, as opentype.js 2.0's own toPathData puts a NaN into some curves of Lato. The text is
// set at the origin and moved with a transform, because large coordinates make some glyphs come out as NaN too.
const pathData = (path) => path.commands.map((c) => (c.type === "Z" ? "Z"
  : c.type + [c.x1, c.y1, c.x2, c.y2, c.x, c.y].filter((v) => v !== undefined).map((v) => v.toFixed(2)).join(" "))).join("");
const namePath = pathData(nameFont.getPath(NAME, 0, 0, nameSize));
const claimPath = pathData(claimFont.getPath(CLAIM, 0, 0, claimSize));
if (/NaN/.test(namePath + claimPath)) throw new Error("a glyph came out as NaN");

// embedLogo places the logo at (x,y,w,h) and keeps its own viewBox.
function embedLogo(x, y, w, h) {
  const raw = readFileSync(join(__dir, LOGO), "utf8").replace(/<\?xml[^>]*\?>\s*/, "");
  return raw.replace(
    /<svg\b[^>]*>/,
    `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" viewBox="${vb.join(" ")}" xmlns="http://www.w3.org/2000/svg">`,
  );
}

function emit(name, svg, bg) {
  writeFileSync(join(__dir, `${name}.svg`), svg);
  const png = new Resvg(svg, { background: bg, fitTo: { mode: "width", value: W } }).render().asPng();
  writeFileSync(join(__dir, `${name}.png`), png);
  console.log(`wrote ${name}.svg and .png`);
}

for (const t of THEMES) {
  emit(`castleparcel-banner${t.suffix}`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${NAME}">
  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  ${embedLogo(LX, LY, LW, LH)}
  <path transform="translate(${textX.toFixed(2)} ${nameBaseline.toFixed(2)})" d="${namePath}" fill="${t.name}"/>
  <path transform="translate(${textX.toFixed(2)} ${claimBaseline.toFixed(2)})" d="${claimPath}" fill="${t.claim}"/>
</svg>
`, t.bg);
}

// The support thread takes a banner without text, on the forum's light surface.
emit("castleparcel-banner-logo", `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${NAME}">
  <rect width="${W}" height="${H}" fill="${THEMES[0].bg}"/>
  ${embedLogo((W - LW) / 2, (H - LH) / 2, LW, LH)}
</svg>
`, THEMES[0].bg);
