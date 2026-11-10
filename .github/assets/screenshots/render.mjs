// Builds the README pictures in .github/assets/screenshots: the options of a
// parcel, its finished link and the page the recipient opens, each from a
// running CastleParcel in a drawn browser window beside a caption, on the dark
// relief background of the store pictures.
//
// Point it at a throwaway server with an empty data directory, never at a real
// one: the shares are made through the real pages, with invented files.
//
//   RATE_LIMIT=false DATA_DIR=<empty dir> PORT=3501 BASE_URL=http://localhost:3501 ./castleparcel
//   node .github/assets/screenshots/render.mjs http://localhost:3501
//
// The links in the second picture show the port, so it stays at 3501.
// Every layer is rendered at twice the size, which keeps the text sharp
// through the window's tilt.
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const base = process.argv[2];
if (!base) throw new Error("usage: node .github/assets/screenshots/render.mjs <server url>");

const VIEW_W = 1280;
const VIEW_H = 780;
const WAIT = { timeout: 120_000 };

// The bar prints a made-up address instead of the demo server's own.
const SHOTS = [
  {
    file: "castleparcel-1.png",
    capture: "options",
    shown: "castle.local/",
    caption: "Drop it, <em>set how long it lives</em>",
    sub: "Expiry, download limit and password before anything leaves your browser",
  },
  {
    file: "castleparcel-2.png",
    capture: "link",
    shown: "castle.local/",
    caption: "One link, <em>one QR code</em>",
    sub: "The key sits in the link, so your server never sees the files",
  },
  {
    file: "castleparcel-3.png",
    capture: "received",
    shown: "castle.local/d/k7Mx9qT2",
    caption: "What your friend <em>gets</em>",
    sub: "No account, no app, and the files are gone when the time is up",
  },
];

async function cached(file, url) {
  const path = join(tmpdir(), `CastleParcel-${file}`);
  if (!existsSync(path)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${file}: fetch ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(path);
}

const dataUrl = (buf, type) => `data:${type};base64,${buf.toString("base64")}`;
const fonts = "https://github.com/google/fonts/raw/main/ofl";
const bree = dataUrl(await cached("BreeSerif-Regular.ttf", `${fonts}/breeserif/BreeSerif-Regular.ttf`), "font/ttf");
const lato = dataUrl(await cached("Lato-Regular.ttf", `${fonts}/lato/Lato-Regular.ttf`), "font/ttf");
const logo = dataUrl(readFileSync(join(root, ".github", "assets", "castleparcel-logo.svg")), "image/svg+xml");

// A small PDF of exactly `bytes`, padded with a comment so the file list
// shows the same size on every run.
function pdf(bytes) {
  const text = "BT /F1 18 Tf 72 760 Td (Lake trip: Friday to Sunday) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const build = (pad) => {
    let out = `%PDF-1.4\n%${"x".repeat(pad)}\n`;
    const offsets = objects.map((body, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
  };
  return Buffer.from(build(bytes - build(0).length), "latin1");
}

// A drawn lake, saved at whatever quality lands nearest to `bytes`, so the
// thumbnail and the size in the lists stay the same from run to run.
async function lakePhoto(browser, bytes) {
  const page = await browser.newPage();
  const url = await page.evaluate((target) => {
    const c = Object.assign(document.createElement("canvas"), { width: 480, height: 320 });
    const g = c.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 190);
    sky.addColorStop(0, "#3d6fa8");
    sky.addColorStop(1, "#cfe3f0");
    g.fillStyle = sky;
    g.fillRect(0, 0, 480, 190);
    g.fillStyle = "#f6e7b8";
    g.beginPath();
    g.arc(352, 92, 24, 0, Math.PI * 2);
    g.fill();
    const ridge = (color, points) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, 200);
      for (const [x, y] of points) g.lineTo(x, y);
      g.lineTo(480, 200);
      g.fill();
    };
    ridge("#6c7f96", [[0, 140], [70, 96], [140, 132], [220, 78], [300, 124], [380, 90], [480, 132]]);
    ridge("#3f5b4c", [[0, 168], [90, 140], [170, 162], [260, 128], [350, 160], [430, 142], [480, 156]]);
    const water = g.createLinearGradient(0, 190, 0, 320);
    water.addColorStop(0, "#5f8fb6");
    water.addColorStop(1, "#1f3f5c");
    g.fillStyle = water;
    g.fillRect(0, 190, 480, 130);
    g.strokeStyle = "rgba(255,255,255,.35)";
    for (let i = 0; i < 18; i++) {
      const y = 205 + i * 6.5;
      g.beginPath();
      g.moveTo(40 + ((i * 53) % 220), y);
      g.lineTo(120 + ((i * 53) % 220) + i * 4, y);
      g.stroke();
    }
    let best = null;
    for (let q = 0.3; q <= 0.99; q += 0.01) {
      const u = c.toDataURL("image/jpeg", q);
      const size = atob(u.split(",")[1]).length;
      if (!best || Math.abs(size - target) < Math.abs(best.size - target)) best = { u, size };
    }
    return best.u;
  }, bytes);
  await page.close();
  return Buffer.from(url.split(",")[1], "base64");
}

async function demoFiles(browser) {
  const dir = mkdtempSync(join(tmpdir(), "castleparcel-demo-"));
  const files = {
    jpg: join(dir, "lake-trip-01.jpg"),
    pdf: join(dir, "itinerary.pdf"),
    txt: join(dir, "packing-list.txt"),
  };
  writeFileSync(files.jpg, await lakePhoto(browser, 11_800));
  writeFileSync(files.pdf, pdf(184_000));
  writeFileSync(files.txt, "towel\nstove\nsocks\n");
  return { dir, files };
}

async function still(page) {
  await page.evaluate(() => document.fonts.ready);
  // Nothing should light up under the pointer of the last click.
  await page.mouse.move(VIEW_W - 1, VIEW_H - 1);
  await page.waitForTimeout(800);
  return page.screenshot();
}

const linkOf = async (page, part) => {
  await page.waitForFunction((p) => [...document.querySelectorAll("input[readonly]")].some((i) => i.value.includes(p)), part, WAIT);
  return page.evaluate((p) => [...document.querySelectorAll("input[readonly]")].find((i) => i.value.includes(p)).value.trim(), part);
};

// Each share gets a fresh browser, so no choice remembered from one leaks
// into the next.
async function share(browser, files, choose) {
  const ctx = await browser.newContext({
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Europe/Vienna",
  });
  const page = await ctx.newPage();
  await page.goto(base, WAIT);
  await page.setInputFiles('input[type="file"]', files);
  await page.locator("[data-cp=upload]").waitFor(WAIT);
  await choose?.(page);
  return { ctx, page };
}

async function captures(browser, files) {
  const trip = [files.jpg, files.pdf, files.txt];
  const shots = {};

  const options = await share(browser, trip, async (page) => {
    await page.locator("[data-cp=limit-count]").click();
    await page.locator("[data-cp=max-downloads]").waitFor(WAIT);
  });
  shots.options = await still(options.page);
  await options.ctx.close();

  const solo = await share(browser, [files.jpg]);
  await solo.page.locator("[data-cp=upload]").click();
  await linkOf(solo.page, "/m/");
  shots.link = await still(solo.page);
  await solo.ctx.close();

  // Without a download limit the page may show the photo as its own
  // thumbnail, since looking costs no download.
  const sent = await share(browser, trip);
  await sent.page.locator("[data-cp=upload]").click();
  const received = await sent.ctx.newPage();
  await received.goto(await linkOf(sent.page, "/d/"), WAIT);
  await received.locator(".cp-thumb").waitFor(WAIT);
  shots.received = await still(received);
  await sent.ctx.close();

  return shots;
}

const STYLE = `
@font-face { font-family: "Bree Serif"; src: url(${bree}); }
@font-face { font-family: Lato; src: url(${lato}); }
* { box-sizing: border-box; margin: 0; }
body { position: relative; width: 1920px; height: 1000px; overflow: hidden; font-family: Lato, sans-serif; background: #0c0c0b; }
.wall { position: absolute; inset: 0; background: radial-gradient(55% 60% at 62% 35%, #26231d, #0f0e0c 72%); }
.relief { position: absolute; width: 46%; left: -9%; top: -4%; transform: rotate(-10deg); opacity: .32;
  filter: grayscale(1) brightness(.36) contrast(1.2) drop-shadow(-2px -2px 0 rgba(255,255,255,.16)) drop-shadow(12px 18px 26px rgba(0,0,0,.85)); }
.vignette { position: absolute; inset: 0; box-shadow: inset 0 0 200px rgba(0,0,0,.6); }
.copy { position: absolute; left: 84px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; gap: 28px; }
.copy img { width: 96px; }
h1 { font: 400 64px/1.12 "Bree Serif", serif; color: #f4f4f4; text-wrap: balance; }
h1 em { font-style: normal; color: #FCC419; }
.sub { font-size: 28px; line-height: 1.35; color: #9d9481; }
.stage { position: absolute; left: 665px; top: 96px; width: 1220px; perspective: 2400px; }
.floor { position: absolute; left: 12%; right: 12%; bottom: -4%; height: 8%; border-radius: 50%; background: rgba(0,0,0,.8); filter: blur(30px); }
.win { position: relative; transform: rotateY(-8deg) rotateX(2deg); border-radius: 14px; overflow: hidden; background: #161616;
  box-shadow: 0 0 0 1px #3c3c3c, 0 2px 4px rgba(0,0,0,.35), 0 18px 36px rgba(0,0,0,.45), 0 52px 100px rgba(0,0,0,.55); }
.win > img { display: block; width: 1220px; height: ${Math.round((VIEW_H * 1220) / VIEW_W)}px; }
.bar { position: relative; display: flex; align-items: center; color: #d6d6d6; font: 400 17px/1 Lato, sans-serif; }
.tabs { height: 42px; padding: 7px 0 0 12px; background: #1c1c1c; align-items: flex-end; }
.tab { display: flex; align-items: center; gap: 10px; height: 35px; padding: 0 70px 0 14px; border-radius: 10px 10px 0 0; background: #2c2c2c; font-size: 15px; }
.tab img { width: 20px; height: 20px; object-fit: contain; }
.address { height: 46px; gap: 14px; padding: 0 14px; background: #2c2c2c; border-bottom: 1px solid #111; }
.url { flex: 1; height: 32px; border-radius: 16px; background: #1a1a1a; padding-left: 18px; display: flex; align-items: center; font-size: 15px; color: #c9c9c9; }
.glare { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(118deg, rgba(255,255,255,.09) 0%, rgba(255,255,255,.03) 28%, rgba(255,255,255,0) 42%); }
`;

const frame = ({ shown, caption, sub }, png) => `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<div class="wall"></div><img class="relief" src="${logo}"><div class="vignette"></div>
<div class="copy"><img src="${logo}"><h1>${caption}</h1><p class="sub">${sub}</p></div>
<div class="stage"><div class="floor"></div><div class="win">
  <div class="bar tabs"><div class="tab"><img src="${logo}"><span>CastleParcel</span></div></div>
  <div class="bar address"><div class="url">${shown}</div></div>
  <img src="${dataUrl(png, "image/png")}"><div class="glare"></div>
</div></div>
</body></html>`;

const browser = await chromium.launch();
const { dir, files } = await demoFiles(browser);
try {
  const shots = await captures(browser, files);
  for (const shot of SHOTS) {
    const big = await browser.newPage({ viewport: { width: 1920, height: 1000 }, deviceScaleFactor: 2 });
    await big.setContent(frame(shot, shots[shot.capture]));
    await big.evaluate(() => document.fonts.ready);
    await big.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
    const png = await big.screenshot();
    await big.close();
    const small = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
    await small.setContent(`<body style="margin:0"><img src="${dataUrl(png, "image/png")}" style="display:block;width:1920px;height:1000px">`);
    await small.locator("img").evaluate((img) => img.decode());
    await small.screenshot({ path: join(here, shot.file) });
    await small.close();
    console.log(`wrote ${shot.file}`);
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
