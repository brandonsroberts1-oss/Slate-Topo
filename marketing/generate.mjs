// Generate Etsy marketing renders: drive the real app per location, capture the
// engraving SVG, wrap it in a slate-slab treatment, add captions + arrows,
// screenshot at 3000×2250.
// Usage: npm i playwright (any dir), then from that dir:
//   OUT_DIR=out node <repo>/marketing/generate.mjs
// TILE_DIR=<dir of {z}_{x}_{y}.png> serves terrain offline; without it, tiles
// come from the live network. CHROMIUM_PATH overrides the browser binary.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

let chromium;
try {
  ({ chromium } = createRequire(join(process.cwd(), 'noop.js'))('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TILE_DIR = process.env.TILE_DIR || null;
const MK = process.env.OUT_DIR || join(tmpdir(), 'slate-topo-marketing');
mkdirSync(MK, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const p = req.url.split('?')[0];
  const file = p.startsWith('/mk/') ? join(MK, p.slice(4)) : join(ROOT, p === '/' ? 'index.html' : p);
  try { const b = readFileSync(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8126, r));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// ---------- capture engraving SVGs from the real app ----------
const LOCS = [
  { id: 'shasta', lat: 41.4092, lon: -122.1949, areaMi: 8, intervalFt: 200, label: 'Mount Shasta\nElev: 14,179 Ft', sub: 'California, USA' },
  { id: 'montblanc', lat: 45.8326, lon: 6.8652, areaMi: 8, intervalFt: 250, label: 'Mont Blanc\nElev: 15,774 Ft', sub: 'French Alps' },
  { id: 'tahoe', lat: 39.0968, lon: -120.0324, areaMi: 26, intervalFt: 250, smooth: 2, label: 'Lake Tahoe\nElev: 6,225 Ft', sub: 'Sierra Nevada, USA' },
  { id: 'canyon', lat: 36.088, lon: -112.11, areaMi: 11, intervalFt: 300, smooth: 2, label: 'Grand Canyon\nArizona, USA', sub: 'Arizona, USA' },
];

const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
await page.route('**/elevation-tiles-prod/terrarium/**', route => {
  const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  const f = TILE_DIR && m && join(TILE_DIR, `${m[1]}_${m[2]}_${m[3]}.png`);
  if (f && existsSync(f)) route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(f) });
  else if (TILE_DIR) route.fulfill({ status: 404, body: 'missing' });
  else route.continue();
});
await page.goto('http://localhost:8126/');
await page.waitForFunction(() => window.SlateTopo && window.SlateTopo.geometry, null, { timeout: 30000 });

const art = {};
for (const L of LOCS) {
  await page.fill('#lat', String(L.lat));
  await page.fill('#lon', String(L.lon));
  await page.fill('#area', String(L.areaMi));
  await page.fill('#interval', String(L.intervalFt));
  await page.fill('#label-text', L.label);
  await page.evaluate(sm => {
    const el = document.getElementById('smoothing');
    el.value = sm; el.dispatchEvent(new Event('input'));
  }, L.smooth || 1);
  await page.evaluate(() => window.SlateTopo.rebuildTerrain()); // bypass debounce, awaits completion
  await page.waitForTimeout(250);
  const check = await page.evaluate(() => ({
    lat: window.SlateTopo.state.lat,
    banner: !document.getElementById('banner').hidden,
  }));
  if (check.banner || Math.abs(check.lat - L.lat) > 1e-6) {
    throw new Error(`terrain rebuild failed for ${L.id} (banner=${check.banner}, lat=${check.lat})`);
  }
  const svg = await page.evaluate(() => document.querySelector('.pv-holder svg').outerHTML);
  art[L.id] = svg.replace('id="preview-svg"', '');
  const levels = await page.evaluate(() => window.SlateTopo.geometry.contours.length);
  console.log(`captured ${L.id}: ${levels} levels, ${(svg.length / 1024).toFixed(0)} KB`);
}
writeFileSync(join(MK, 'art.json'), JSON.stringify(art));

// ---------- shared page chrome ----------
const fontCss = (() => {
  const data = readFileSync(join(ROOT, 'vendor/fonts-data.js'), 'utf8');
  const fonts = JSON.parse('[' + data.split('window.SLATE_FONTS = [')[1].split('];')[0].replace(/,\s*$/, '') + ']');
  return fonts.map(f => `@font-face{font-family:'${f.id}';src:url(data:font/ttf;base64,${f.base64});}`).join('\n');
})();

let uid = 0;
function slab(artSvg, sizePx, opts = {}) {
  const id = 'sl' + (uid++);
  const seed = opts.seed || (7 + uid * 13);
  const rot = opts.rot || 0;
  return `
  <div class="coaster" style="width:${sizePx}px;height:${sizePx}px;transform:rotate(${rot}deg)">
    <svg class="slab" viewBox="0 0 1000 1000">
      <defs>
        <linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#39404a"/><stop offset=".45" stop-color="#2d333b"/>
          <stop offset=".8" stop-color="#262c33"/><stop offset="1" stop-color="#2b3139"/>
        </linearGradient>
        <filter id="${id}c" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.011 0.016" numOctaves="3" seed="${seed}" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="11"/>
        </filter>
        <filter id="${id}g">
          <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2" seed="${seed + 1}"/>
          <feColorMatrix type="saturate" values="0"/>
        </filter>
      </defs>
      <g filter="url(#${id}c)">
        <rect x="30" y="30" width="940" height="940" rx="36" fill="#14181c"/>
        <rect x="37" y="37" width="926" height="926" rx="31" fill="url(#${id}f)"/>
        <rect x="37" y="37" width="926" height="926" rx="31" filter="url(#${id}g)" opacity="0.10" style="mix-blend-mode:overlay"/>
      </g>
    </svg>
    <div class="art">${artSvg}</div>
  </div>`;
}

function pageShell(body, extraCss = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss}
*{box-sizing:border-box;margin:0}
html,body{width:1500px;height:1125px;overflow:hidden}
body{position:relative;font-family:'roboto',sans-serif;color:#2e2a23;
  background:radial-gradient(130% 95% at 28% 8%,#f9f5eb 0%,#f1e9d8 52%,#e7dcc4 100%);}
.coaster{position:relative;display:inline-block}
.coaster .slab{position:absolute;inset:0;width:100%;height:100%;
  filter:drop-shadow(0 22px 30px rgba(46,36,20,.38)) drop-shadow(0 5px 9px rgba(46,36,20,.22));}
.coaster .art{position:absolute;inset:4.6%;opacity:.97;
  filter:drop-shadow(0 0 .5px rgba(235,240,240,.55));}
.coaster .art svg{width:100%;height:100%;display:block}
.pv-slate{display:none}
.pv-lines{stroke:#dde3e4}
.pv-border{stroke:#dde3e4}
.pv-label{fill:#e5eaea}
.abs{position:absolute}
h1{font-family:'roboto-slab',serif;font-weight:500;color:#2e2a23}
.sub{color:#75674f;font-size:23px;letter-spacing:.02em}
.cap{font-family:'pacifico',cursive;color:#a8502b;line-height:1.35}
.arrows{position:absolute;inset:0;pointer-events:none}
.arrows path{fill:none;stroke:#a8502b;stroke-width:4.5;stroke-linecap:round}
${extraCss}
</style></head><body>${body}</body></html>`;
}

// hand-drawn-ish arrow: quadratic with a chevron head
function arrow(x1, y1, x2, y2, bend = 0.25) {
  const mx = (x1 + x2) / 2 - (y2 - y1) * bend;
  const my = (y1 + y2) / 2 + (x2 - x1) * bend;
  // chevron direction from control point to tip
  const ang = Math.atan2(y2 - my, x2 - mx);
  const a1 = ang + 2.5, a2 = ang - 2.5, r = 16;
  const h1 = `M${x2 + r * Math.cos(a1)} ${y2 + r * Math.sin(a1)}L${x2} ${y2}L${x2 + r * Math.cos(a2)} ${y2 + r * Math.sin(a2)}`;
  return `<path d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}"/><path d="${h1}"/>`;
}

// ---------- image 1: hero with callouts ----------
const img1 = pageShell(`
  <div class="abs" style="left:64px;top:56px">
    <h1 style="font-size:58px">Your Mountain. Set in Stone.</h1>
    <div class="sub" style="margin-top:12px">Custom topographic slate coaster &nbsp;·&nbsp; engraved from real elevation data</div>
  </div>
  <div class="abs" style="left:120px;top:262px">${slab(art.shasta, 660, { rot: -2.2, seed: 11 })}</div>

  <div class="abs cap" style="left:905px;top:268px;font-size:37px;width:480px">any place on Earth —<br>just tell us where</div>
  <div class="abs cap" style="left:1010px;top:560px;font-size:33px;width:430px">real contour lines<br>from survey data</div>
  <div class="abs cap" style="left:850px;top:872px;font-size:35px;width:520px">personalized name<br>&amp; elevation</div>
  <div class="abs cap" style="left:96px;top:988px;font-size:31px">natural hand-cut slate · 4″ × 4″</div>

  <svg class="arrows" viewBox="0 0 1500 1125">
    ${arrow(890, 330, 570, 480, 0.22)}
    ${arrow(1000, 620, 748, 655, 0.16)}
    ${arrow(838, 918, 405, 838, -0.2)}
    ${arrow(330, 1000, 262, 918, 0.25)}
  </svg>
`);
writeFileSync(join(MK, 'img1.html'), img1);

// ---------- image 2: any place grid ----------
const img2 = pageShell(`
  <div class="abs" style="left:0;right:0;top:44px;text-align:center">
    <h1 style="font-size:56px">Anywhere you love, <span class="cap" style="font-size:58px">mapped.</span></h1>
    <div class="sub" style="margin-top:10px">Mountains · lakes · canyons · hometowns — every design engraved from real terrain</div>
  </div>
  <div class="abs" style="left:265px;top:228px">${slab(art.shasta, 390, { rot: -1.6, seed: 21 })}</div>
  <div class="abs" style="left:845px;top:228px">${slab(art.montblanc, 390, { rot: 1.4, seed: 22 })}</div>
  <div class="abs" style="left:265px;top:662px">${slab(art.tahoe, 390, { rot: 1.2, seed: 23 })}</div>
  <div class="abs" style="left:845px;top:662px">${slab(art.canyon, 390, { rot: -1.3, seed: 24 })}</div>
  <div class="abs sub" style="left:265px;top:628px;width:390px;text-align:center;font-size:20px">California, USA</div>
  <div class="abs sub" style="left:845px;top:628px;width:390px;text-align:center;font-size:20px">French Alps</div>
  <div class="abs sub" style="left:265px;top:1058px;width:390px;text-align:center;font-size:20px">Sierra Nevada, USA</div>
  <div class="abs sub" style="left:845px;top:1058px;width:390px;text-align:center;font-size:20px">Arizona, USA</div>
`);
writeFileSync(join(MK, 'img2.html'), img2);

// ---------- image 3: personalization / fonts ----------
const chip = (font, line1, line2, tag) => `
  <div class="chip">
    <div class="chip-face">
      <div style="font-family:'${font}';font-size:${font === 'pacifico' ? 30 : 31}px;color:#e6eaea">${line1}</div>
      <div style="font-family:'${font}';font-size:${font === 'pacifico' ? 22 : 23}px;color:#dbe1e2;margin-top:${font === 'pacifico' ? 6 : 4}px">${line2}</div>
    </div>
    <div class="cap" style="font-size:26px;position:absolute;right:22px;bottom:14px">${tag}</div>
  </div>`;
const img3 = pageShell(`
  <div class="abs" style="left:64px;top:56px">
    <h1 style="font-size:58px">Make it yours</h1>
    <div class="sub" style="margin-top:12px">Any wording — the engraved panel sizes itself to your text</div>
  </div>
  <div class="abs" style="left:96px;top:300px">${slab(art.montblanc, 620, { rot: -2, seed: 31 })}</div>
  <div class="abs" style="left:820px;top:262px;display:flex;flex-direction:column;gap:34px">
    ${chip('roboto-slab', 'Mont Blanc', 'Elev: 15,774 Ft', 'classic slab')}
    ${chip('roboto', 'Mont Blanc', 'Elev: 15,774 Ft', 'clean modern')}
    ${chip('pacifico', 'Mont Blanc', 'Elev: 15,774 Ft', 'handwritten')}
  </div>
  <div class="abs cap" style="left:928px;top:962px;font-size:34px">engraved just like this</div>
  <svg class="arrows" viewBox="0 0 1500 1125">
    ${arrow(910, 985, 400, 852, 0.16)}
  </svg>
`, `
.chip{position:relative;width:560px;height:172px;border-radius:16px;
  background:linear-gradient(135deg,#39404a,#262c33 70%);
  box-shadow:0 12px 22px rgba(46,36,20,.30), inset 0 1px 0 rgba(255,255,255,.06);}
.chip-face{position:absolute;left:34px;top:50%;transform:translateY(-50%)}
`);
writeFileSync(join(MK, 'img3.html'), img3);

// ---------- image 4: how it works ----------
const contourDark = art.shasta
  .replace(/class="pv-lines"/g, 'class="ink-lines"')
  .replace(/class="pv-border"/g, 'class="ink-border"')
  .replace(/class="pv-label"/g, 'class="ink-label"')
  .replace(/class="pv-slate"/g, 'class="ink-slate"');
const img4 = pageShell(`
  <div class="abs" style="left:0;right:0;top:48px;text-align:center">
    <h1 style="font-size:54px">From coordinates to keepsake</h1>
    <div class="sub" style="margin-top:10px">Every coaster is one of a kind — made from a place that matters to you</div>
  </div>
  <div class="card" style="left:96px">
    <div class="step">1</div><div class="ct">Pick your place</div>
    <svg viewBox="0 0 100 100" style="width:170px;height:170px;margin:34px auto 12px;display:block">
      <path d="M50 12c-14 0-24 10.5-24 24 0 17 24 50 24 50s24-33 24-50c0-13.5-10-24-24-24z" fill="none" stroke="#a8502b" stroke-width="5" stroke-linejoin="round"/>
      <circle cx="50" cy="35.5" r="9" fill="none" stroke="#a8502b" stroke-width="5"/>
    </svg>
    <div class="cd">“Mount Shasta, California”</div>
    <div class="cc">41.4092° N · 122.1949° W</div>
    <div class="cap" style="font-size:26px;text-align:center;margin-top:26px">any mountain, lake,<br>town or trail on Earth</div>
  </div>
  <div class="card" style="left:550px">
    <div class="step">2</div><div class="ct">We map real terrain</div>
    <div style="width:300px;height:300px;margin:26px auto 0" class="inkwrap">${contourDark}</div>
    <div class="cap" style="font-size:26px;text-align:center;margin-top:24px">true elevation data,<br>line by line</div>
  </div>
  <div class="card" style="left:1004px">
    <div class="step">3</div><div class="ct">Engraved on slate</div>
    <div style="margin:26px auto 0;width:300px">${slab(art.shasta, 300, { rot: 0, seed: 41 })}</div>
    <div class="cap" style="font-size:26px;text-align:center;margin-top:24px">laser-etched, crisp<br>&amp; made to last</div>
  </div>
`, `
.card{position:absolute;top:262px;width:400px;height:680px;background:#fcf8ef;border-radius:20px;
  box-shadow:0 16px 30px rgba(46,36,20,.16), inset 0 1px 0 #fff;padding:38px 30px 0;}
.step{width:54px;height:54px;border-radius:50%;background:#a8502b;color:#fcf8ef;font-family:'roboto-slab';
  font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto}
.ct{font-family:'roboto-slab';font-size:30px;text-align:center;margin-top:16px}
.cd{font-size:24px;text-align:center;color:#2e2a23}
.cc{font-size:20px;text-align:center;color:#75674f;margin-top:8px;letter-spacing:.04em}
.inkwrap svg{width:100%;height:100%}
.ink-slate{display:none}
.ink-lines{stroke:#3a352c}
.ink-border{stroke:#3a352c}
.ink-label{fill:#3a352c}
`);
writeFileSync(join(MK, 'img4.html'), img4);

// ---------- screenshot all ----------
const shot = await browser.newPage({ viewport: { width: 1500, height: 1125 }, deviceScaleFactor: 2 });
for (const n of ['img1', 'img2', 'img3', 'img4']) {
  await shot.goto(`http://localhost:8126/mk/${n}.html`);
  await shot.waitForTimeout(900); // fonts + filters settle
  await shot.screenshot({ path: join(MK, `etsy-${n}.jpg`), type: 'jpeg', quality: 90 });
  console.log('rendered', n);
}
await browser.close();
server.close();
console.log('DONE');
