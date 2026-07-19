// Generate Etsy marketing renders: drive the real app per location, capture the
// engraving SVG, wrap it in a slate-slab treatment on a rustic dark-wood
// tabletop, add captions + arrows, screenshot at 3000×2250 (plus 2048² thumb).
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
  { id: 'crater', lat: 42.9446, lon: -122.109, areaMi: 9, intervalFt: 100, smooth: 1, label: 'Crater Lake\nElev: 6,178 Ft', sub: 'Oregon, USA' },
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
          <stop offset="0" stop-color="#3b424c"/><stop offset=".45" stop-color="#2e343c"/>
          <stop offset=".8" stop-color="#272d34"/><stop offset="1" stop-color="#2c323a"/>
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
        <rect x="30" y="30" width="940" height="940" rx="36" fill="#101418"/>
        <rect x="37" y="37" width="926" height="926" rx="31" fill="url(#${id}f)"/>
        <rect x="37" y="37" width="926" height="926" rx="31" filter="url(#${id}g)" opacity="0.10" style="mix-blend-mode:overlay"/>
        <rect x="40" y="40" width="920" height="920" rx="29" fill="none" stroke="rgba(240,228,205,0.10)" stroke-width="4"/>
      </g>
    </svg>
    <div class="art">${artSvg}</div>
  </div>`;
}

// Rustic tabletop: horizontal walnut planks, stretched grain, a warm light
// pool (spotX/spotY in %) and darkened edges.
function wood(spotX = 50, spotY = 40) {
  const planks = [];
  const shades = ['#4a3625', '#42301f', '#4d3928', '#3e2d1e', '#463323', '#403021'];
  const H = 1125 / 6;
  for (let i = 0; i < 6; i++) {
    planks.push(`<rect x="0" y="${(i * H).toFixed(1)}" width="1500" height="${H.toFixed(1)}" fill="${shades[i]}"/>`);
    planks.push(`<rect x="0" y="${(i * H).toFixed(1)}" width="1500" height="2.5" fill="rgba(20,12,6,0.7)"/>`);
    planks.push(`<rect x="0" y="${(i * H + 2.5).toFixed(1)}" width="1500" height="2" fill="rgba(255,230,190,0.05)"/>`);
  }
  return `
  <svg class="wood" viewBox="0 0 1500 1125" preserveAspectRatio="xMidYMid slice">
    <defs>
      <filter id="wgd" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.0042 0.11" numOctaves="4" seed="13"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0 0 0 0"/>
      </filter>
      <filter id="wgl" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.16" numOctaves="3" seed="29"/>
        <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.87  0 0 0 0 0.65  0.35 0 0 0 0"/>
      </filter>
      <radialGradient id="wvig" cx="${spotX}%" cy="${spotY}%" r="78%">
        <stop offset="0" stop-color="rgba(255,236,200,0.13)"/>
        <stop offset="0.42" stop-color="rgba(255,236,200,0.03)"/>
        <stop offset="0.75" stop-color="rgba(12,7,3,0.25)"/>
        <stop offset="1" stop-color="rgba(10,6,2,0.62)"/>
      </radialGradient>
    </defs>
    ${planks.join('')}
    <rect x="0" y="0" width="1500" height="1125" filter="url(#wgd)" opacity="0.5"/>
    <rect x="0" y="0" width="1500" height="1125" filter="url(#wgl)" opacity="0.35" style="mix-blend-mode:soft-light"/>
    <rect x="0" y="0" width="1500" height="1125" fill="url(#wvig)"/>
  </svg>`;
}

function pageShell(body, extraCss = '', w = 1500, h = 1125, spot = [50, 40]) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss}
*{box-sizing:border-box;margin:0}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{position:relative;font-family:'roboto',sans-serif;color:#f4ecdb;background:#3e2d1e}
.wood{position:absolute;inset:0;width:100%;height:100%}
.coaster{position:relative;display:inline-block}
.coaster .slab{position:absolute;inset:0;width:100%;height:100%;
  filter:drop-shadow(0 24px 30px rgba(8,5,2,.62)) drop-shadow(0 6px 10px rgba(8,5,2,.42));}
.coaster .art{position:absolute;inset:4.6%;opacity:.97;
  filter:drop-shadow(0 0 .5px rgba(235,240,240,.55));}
.coaster .art svg{width:100%;height:100%;display:block}
.pv-slate{display:none}
.pv-lines{stroke:#dde3e4}
.pv-border{stroke:#dde3e4}
.pv-label{fill:#e5eaea}
.abs{position:absolute}
h1{font-family:'roboto-slab',serif;font-weight:500;color:#f6eedd}
.sub{color:#d3bfa0;font-size:23px;letter-spacing:.02em}
.cap{font-family:'pacifico',cursive;color:#f0e2c8;line-height:1.35}
.accent{color:#e08a58}
.arrows{position:absolute;inset:0;pointer-events:none}
.arrows path{fill:none;stroke:#f0e2c8;stroke-width:4.5;stroke-linecap:round}
${extraCss}
</style></head><body>${wood(spot[0], spot[1])}${body}</body></html>`;
}

// hand-drawn-ish arrow: quadratic with a chevron head
function arrow(x1, y1, x2, y2, bend = 0.25) {
  const mx = (x1 + x2) / 2 - (y2 - y1) * bend;
  const my = (y1 + y2) / 2 + (x2 - x1) * bend;
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
`, '', 1500, 1125, [34, 46]);
writeFileSync(join(MK, 'img1.html'), img1);

// ---------- image 2: any place grid ----------
const img2 = pageShell(`
  <div class="abs" style="left:0;right:0;top:44px;text-align:center">
    <h1 style="font-size:56px">Anywhere you love, <span class="cap accent" style="font-size:58px">mapped.</span></h1>
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
`, '', 1500, 1125, [50, 46]);
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
  background:linear-gradient(135deg,#3b424c,#272d34 70%);
  box-shadow:0 14px 24px rgba(8,5,2,.5), inset 0 1px 0 rgba(255,255,255,.07);
  outline:1px solid rgba(240,228,205,.08);}
.chip-face{position:absolute;left:34px;top:50%;transform:translateY(-50%)}
`, 1500, 1125, [30, 50]);
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
    <div class="cap ccap" style="font-size:26px;text-align:center;margin-top:26px">any mountain, lake,<br>town or trail on Earth</div>
  </div>
  <div class="card" style="left:550px">
    <div class="step">2</div><div class="ct">We map real terrain</div>
    <div style="width:300px;height:300px;margin:26px auto 0" class="inkwrap">${contourDark}</div>
    <div class="cap ccap" style="font-size:26px;text-align:center;margin-top:24px">true elevation data,<br>line by line</div>
  </div>
  <div class="card" style="left:1004px">
    <div class="step">3</div><div class="ct">Engraved on slate</div>
    <div style="margin:26px auto 0;width:300px">${slab(art.shasta, 300, { rot: 0, seed: 41 })}</div>
    <div class="cap ccap" style="font-size:26px;text-align:center;margin-top:24px">laser-etched, crisp<br>&amp; made to last</div>
  </div>
`, `
.card{position:absolute;top:262px;width:400px;height:680px;background:#f7f1e3;border-radius:20px;
  box-shadow:0 18px 30px rgba(8,5,2,.5), inset 0 1px 0 #fff;padding:38px 30px 0;color:#2e2a23}
.step{width:54px;height:54px;border-radius:50%;background:#a8502b;color:#f7f1e3;font-family:'roboto-slab';
  font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto}
.ct{font-family:'roboto-slab';font-size:30px;text-align:center;margin-top:16px;color:#2e2a23}
.cd{font-size:24px;text-align:center;color:#2e2a23}
.cc{font-size:20px;text-align:center;color:#75674f;margin-top:8px;letter-spacing:.04em}
.ccap{color:#a8502b}
.inkwrap svg{width:100%;height:100%}
.ink-slate{display:none}
.ink-lines{stroke:#3a352c}
.ink-border{stroke:#3a352c}
.ink-label{fill:#3a352c}
`, 1500, 1125, [50, 44]);
writeFileSync(join(MK, 'img4.html'), img4);

// ---------- thumbnail: Crater Lake, 2048² ----------
const thumb = pageShell(`
  <div class="abs" style="left:0;right:0;top:46px;text-align:center;letter-spacing:.32em;color:#ead9b8;font-size:27px;font-family:'roboto-slab'">CUSTOM&nbsp;TOPOGRAPHIC&nbsp;COASTER</div>
  <div class="abs" style="left:162px;top:136px">${slab(art.crater, 700, { rot: -2, seed: 51 })}</div>
  <div class="abs cap" style="left:0;right:0;top:886px;text-align:center;font-size:56px">any place on Earth</div>
`, '', 1024, 1024, [50, 44]);
writeFileSync(join(MK, 'thumb.html'), thumb);

// ---------- screenshot all ----------
const shot = await browser.newPage({ viewport: { width: 1500, height: 1125 }, deviceScaleFactor: 2 });
for (const n of ['img1', 'img2', 'img3', 'img4']) {
  await shot.goto(`http://localhost:8126/mk/${n}.html`);
  await shot.waitForTimeout(900);
  await shot.screenshot({ path: join(MK, `etsy-${n}.jpg`), type: 'jpeg', quality: 90 });
  console.log('rendered', n);
}
await shot.setViewportSize({ width: 1024, height: 1024 });
await shot.goto('http://localhost:8126/mk/thumb.html');
await shot.waitForTimeout(900);
await shot.screenshot({ path: join(MK, 'etsy-thumb.jpg'), type: 'jpeg', quality: 90 });
console.log('rendered thumb');

await browser.close();
server.close();
console.log('DONE');
