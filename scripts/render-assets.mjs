// Renders the image assets other than the README banners, which
// .github/assets/gen-banner.mjs draws:
//   .github/assets/icon.png        512x512 Community Applications icon
//   public/icon-512.png            the same icon for the web app manifest
//   public/favicon.svg             the app icon, unchanged
//   public/opengraph-image.png     1200x630 link preview card
// The icons come from castleparcel-app.svg, the card from castleparcel-logo.svg.
// Text becomes SVG paths, so nothing depends on a font being installed.
//
// Usage:  npm i -g @resvg/resvg-js opentype.js && node scripts/render-assets.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const gRoot = execSync("npm root -g").toString().trim();
const { Resvg } = require(`${gRoot}/@resvg/resvg-js`);
const opentype = require(`${gRoot}/opentype.js`);

const root = fileURLToPath(new URL("..", import.meta.url));
const assets = join(root, ".github", "assets");
const pub = join(root, "public");
const appSvg = join(assets, "castleparcel-app.svg");
const logoSvg = readFileSync(join(assets, "castleparcel-logo.svg"), "utf8");

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

// The tile has rounded corners, and Community Applications and maskable
// manifest icons both want a solid square, so the corners are filled white.
const icon = new Resvg(readFileSync(appSvg, "utf8"), { background: "#ffffff", fitTo: { mode: "width", value: 512 } })
  .render()
  .asPng();
writeFileSync(join(assets, "icon.png"), icon);
writeFileSync(join(pub, "icon-512.png"), icon);
copyFileSync(appSvg, join(pub, "favicon.svg"));

// The link preview card shows for every share, so it carries the product and
// never anything about the file.
const W = 1600, H = 840;
const LH = 520;
const vb = logoSvg.match(/viewBox="([^"]+)"/)[1].split(/[\s,]+/).map(Number);
const LW = (LH * vb[2]) / vb[3];
const nameSize = 144, claimSize = 46, gap = 80;
const pathData = (path) => path.commands.map((c) => (c.type === "Z" ? "Z"
  : c.type + [c.x1, c.y1, c.x2, c.y2, c.x, c.y].filter((v) => v !== undefined).map((v) => v.toFixed(2)).join(" "))).join("");
const NAME = "CastleParcel";
const CLAIM = "Sealed in the keep. Only your link gets in.";
const textW = Math.max(nameFont.getAdvanceWidth(NAME, nameSize), claimFont.getAdvanceWidth(CLAIM, claimSize));
const LX = (W - (LW + gap + textW)) / 2;
const textX = LX + LW + gap;
const nameBaseline = H / 2 - 10;
const claimBaseline = nameBaseline + claimSize * 1.6;
const logo = logoSvg
  .replace(/<\?xml[^>]*\?>\s*/, "")
  .replace(/<svg\b[^>]*>/, `<svg x="${LX.toFixed(1)}" y="${((H - LH) / 2).toFixed(1)}" width="${LW.toFixed(1)}" height="${LH}" viewBox="${vb.join(" ")}" xmlns="http://www.w3.org/2000/svg">`);
const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0d1117"/>
  ${logo}
  <path transform="translate(${textX.toFixed(2)} ${nameBaseline})" d="${pathData(nameFont.getPath(NAME, 0, 0, nameSize))}" fill="#e6edf3"/>
  <path transform="translate(${textX.toFixed(2)} ${claimBaseline})" d="${pathData(claimFont.getPath(CLAIM, 0, 0, claimSize))}" fill="#9aa4ad"/>
</svg>
`;
if (/NaN/.test(card)) throw new Error("a glyph came out as NaN");
writeFileSync(
  join(pub, "opengraph-image.png"),
  new Resvg(card, { background: "#0d1117", fitTo: { mode: "width", value: 1200 } }).render().asPng(),
);

console.log("wrote .github/assets/icon.png, public/icon-512.png, public/favicon.svg, public/opengraph-image.png");
