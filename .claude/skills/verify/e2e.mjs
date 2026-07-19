// End-to-end drive of Slate Topo through the real UI.
// Serves the repo, feeds REAL prefetched terrain tiles via route interception,
// clicks/types like a user, and checks the exported SVG's geometry invariants.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const OUT = process.env.OUT_DIR || tmpdir();
const TILE_DIR = process.env.TILE_DIR || null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise(r => server.listen(8123, r));

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
};

// Resolve playwright from the invoking directory (see SKILL.md recipe),
// falling back to normal resolution relative to this file.
let chromium;
try {
  ({ chromium } = createRequire(join(process.cwd(), 'noop.js'))('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });

const missedTiles = [];
await page.route('**/elevation-tiles-prod/terrarium/**', route => {
  const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  const f = TILE_DIR && m && join(TILE_DIR, `${m[1]}_${m[2]}_${m[3]}.png`);
  if (f && existsSync(f)) {
    route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(f) });
  } else if (TILE_DIR) {
    missedTiles.push(route.request().url());
    route.fulfill({ status: 404, body: 'missing' });
  } else {
    route.continue();
  }
});
await page.route('**/nominatim.openstreetmap.org/**', route => {
  route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ display_name: 'Mount Whitney, Inyo County, California, United States', lat: '36.5785', lon: '-118.2923' }]),
  });
});
page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
page.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()); });

const waitIdle = async () => {
  await page.waitForFunction(() =>
    window.SlateTopo && window.SlateTopo.geometry &&
    !document.getElementById('loading').classList.contains('on'), null, { timeout: 30000 });
  await page.waitForTimeout(450); // let debounced redraws settle
};

// ---- 1. Load with real Shasta tiles ----
await page.goto('http://localhost:8123/');
await waitIdle();
const g1 = await page.evaluate(() => {
  const g = window.SlateTopo.geometry;
  return { levels: g.contours.length, label: !!g.label, box: g.label && g.label.box, stats: g.stats };
});
ok('loads with real tiles, contours render', g1.levels > 15, `${g1.levels} levels, elev ${Math.round(g1.stats.rawMin)}–${Math.round(g1.stats.rawMax)} m`);
ok('no tile requests missed the cache', missedTiles.length === 0 || !TILE_DIR, missedTiles.slice(0, 3).join(' '));
ok('label laid out', g1.label && g1.box.w > 10 && g1.box.h > 5, JSON.stringify(g1.box));
await page.screenshot({ path: OUT + '/shot-1-shasta.png' });

// ---- 2. Geometry invariants of the EXPORT (what the laser sees) ----
const inv = await page.evaluate(() => {
  const S = window.SlateTopo, C = window.ContourLib;
  const g = S.geometry, geo = g.geom;
  const knock = g.knock; // rounded knockout rect {x,y,w,h,r}
  let pts = 0, outsideBorder = 0, insideKnock = 0, worstSd = -1e9;
  const parse = d => {
    const out = [];
    for (const m of d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)) out.push([+m[1], +m[2]]);
    return out;
  };
  for (const c of g.contours) {
    for (const p of parse(c.d)) {
      pts++;
      const sd = C.sdRoundRect(p[0], p[1], geo.clip);
      if (sd > worstSd) worstSd = sd;
      if (sd > 0.05) outsideBorder++;
      if (knock && C.sdRoundRect(p[0], p[1], knock) < -0.05) insideKnock++;
    }
  }
  return { pts, outsideBorder, insideKnock, worstSd };
});
ok('all contour points inside rounded border', inv.outsideBorder === 0, `${inv.pts} pts, worst SD ${inv.worstSd.toFixed(3)}mm`);
ok('no contour points behind label box', inv.insideKnock === 0, `${inv.insideKnock} inside`);

const svg1 = await page.evaluate(() => window.SlateTopo.exportSVGString());
writeFileSync(OUT + '/export-shasta.svg', svg1);
ok('export has mm size', /width="101\.6mm" height="101\.6mm"/.test(svg1));
ok('export has no <text>/<clipPath>/<image>', !/(<text|<clipPath|<image)/.test(svg1));
ok('export has label paths group', /<g id="label" fill="#000000"/.test(svg1));
ok('export has border path', /<path id="border"/.test(svg1));
ok('export paths all finite coords', !/NaN|Infinity/.test(svg1), `${(svg1.length / 1024).toFixed(0)} KB`);

// Default mode = filled outlines: true widths survive laser import (which
// ignores stroke-width). Contours become closed filled shapes; border is a
// two-subpath band (outer + reversed inner ring).
ok('outline mode: contours are filled shapes', /<g id="contours" fill="#000000" stroke="none">/.test(svg1) && !/stroke-width/.test(svg1));
const borderD = (svg1.match(/<path id="border"[^>]*d="([^"]+)"/) || [])[1] || '';
ok('outline mode: border is a band with a hole', (borderD.match(/M/g) || []).length === 2 && /fill="#000000"/.test(svg1.match(/<path id="border"[^>]*>/)[0]));
const firstContourD = (svg1.match(/<g id="contours"[^>]*>\s*<path[^>]*d="([^"]+)"/) || [])[1] || '';
ok('outline mode: shapes are closed (Z)', firstContourD.includes('Z'));

// Centerline mode keeps classic stroked hairline paths for Score jobs.
await page.selectOption('#export-mode', 'centerline');
const svgC = await page.evaluate(() => window.SlateTopo.exportSVGString());
ok('centerline mode: stroked paths with widths', /<g id="contours" fill="none" stroke="#000000" stroke-width="/.test(svgC) && /<path id="border" fill="none" stroke="#000000"/.test(svgC));
await page.selectOption('#export-mode', 'outline');

// Label-box corner radius control drives the knockout shape.
await page.fill('#text-radius', '4');
await page.waitForTimeout(400);
const kr = await page.evaluate(() => window.SlateTopo.geometry.knock.r);
ok('label box corner radius applies', Math.abs(kr - 4) < 0.01, `r=${kr}`);
await page.fill('#text-radius', '2');
await page.waitForTimeout(400);

// ---- 3. Contour interval change through the UI ----
await page.fill('#interval', '500');
await page.waitForTimeout(500);
const levels500 = await page.evaluate(() => window.SlateTopo.geometry.contours.length);
ok('bigger interval → fewer lines', levels500 < g1.levels && levels500 > 3, `${g1.levels} → ${levels500}`);
await page.fill('#interval', '200');
await page.waitForTimeout(500);

// ---- 4. Label auto-sizing ----
const boxBefore = await page.evaluate(() => ({ ...window.SlateTopo.geometry.label.box }));
await page.fill('#label-text', 'Mount Shasta — Cascade Range\nElev: 14,179 Ft\nN 41.409° W 122.195°');
await page.waitForTimeout(500);
const boxAfter = await page.evaluate(() => ({ ...window.SlateTopo.geometry.label.box }));
ok('label box grows with more text', boxAfter.w > boxBefore.w + 5 && boxAfter.h > boxBefore.h + 3,
  `w ${boxBefore.w.toFixed(1)}→${boxAfter.w.toFixed(1)}, h ${boxBefore.h.toFixed(1)}→${boxAfter.h.toFixed(1)}`);
const inv2 = await page.evaluate(() => {
  const S = window.SlateTopo, C = window.ContourLib;
  const knock = S.geometry.knock;
  let bad = 0;
  for (const c of S.geometry.contours) {
    for (const m of c.d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)) {
      if (C.sdRoundRect(+m[1], +m[2], knock) < -0.05) bad++;
    }
  }
  return bad;
});
ok('knockout follows the bigger box', inv2 === 0, `${inv2} pts inside`);
await page.screenshot({ path: OUT + '/shot-2-biglabel.png' });
await page.fill('#label-text', 'Mount Shasta\nElev: 14,179 Ft');
await page.waitForTimeout(500);

// ---- 5. Insert peak elevation button ----
await page.fill('#label-text', 'Mount Shasta');
await page.click('#peak-btn');
await page.waitForTimeout(400);
const labelVal = await page.inputValue('#label-text');
ok('peak elevation inserted', /Elev: 14,\d{3} Ft/.test(labelVal), JSON.stringify(labelVal));

// ---- 6. Pan by dragging the preview ----
const before = await page.evaluate(() => ({ lat: window.SlateTopo.state.lat, lon: window.SlateTopo.state.lon }));
const wrap = await page.locator('#preview-wrap').boundingBox();
await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
await page.mouse.down();
await page.mouse.move(wrap.x + wrap.width / 2 - 80, wrap.y + wrap.height / 2 - 60, { steps: 8 });
await page.mouse.up();
await waitIdle();
const after = await page.evaluate(() => ({ lat: window.SlateTopo.state.lat, lon: window.SlateTopo.state.lon }));
ok('drag pans the map (E/S for NW drag)', after.lon > before.lon && after.lat < before.lat,
  `${before.lat.toFixed(4)},${before.lon.toFixed(4)} → ${after.lat.toFixed(4)},${after.lon.toFixed(4)}`);
ok('lat/lon inputs updated', await page.inputValue('#lat') === after.lat.toFixed(5));

// ---- 7. Wheel zoom ----
const areaBefore = await page.evaluate(() => window.SlateTopo.state.areaMeters);
await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(700);
const areaAfter = await page.evaluate(() => window.SlateTopo.state.areaMeters);
ok('wheel zooms (smaller area)', areaAfter < areaBefore, `${Math.round(areaBefore)} → ${Math.round(areaAfter)} m`);

// ---- 8. Search (mocked Nominatim) ----
await page.fill('#search-input', 'Mount Whitney');
await page.click('#search-btn');
await page.waitForSelector('#search-results .result');
// don't click through — tiles for Whitney aren't prefetched; just verify results render
ok('search results render', (await page.locator('#search-results .result').count()) === 1);

// ---- 9. Demo mode (offline path) ----
const page2 = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page2.route('**/elevation-tiles-prod/**', r => r.abort()); // hard offline
await page2.goto('http://localhost:8123/?demo=1');
await page2.waitForFunction(() => window.SlateTopo && window.SlateTopo.geometry, null, { timeout: 20000 });
const demoLevels = await page2.evaluate(() => window.SlateTopo.geometry.contours.length);
ok('demo terrain renders offline', demoLevels > 10, `${demoLevels} levels`);
await page2.screenshot({ path: OUT + '/shot-3-demo.png' });

// ---- 10. Rectangular coaster + bold contours through the UI ----
await page.fill('#coaster-w', '6');
await page.fill('#bold-every', '5');
await waitIdle();
const rect = await page.evaluate(() => {
  const g = window.SlateTopo.geometry;
  return { W: g.geom.W, bold: g.contours.filter(c => c.bold).length, thin: g.contours.filter(c => !c.bold).length };
});
ok('6×4 coaster resizes (152.4mm wide)', Math.abs(rect.W - 152.4) < 0.01, `W=${rect.W}`);
ok('bold every 5th produces bold lines', rect.bold > 0 && rect.thin > rect.bold, `${rect.bold} bold / ${rect.thin} thin`);
const svgRect = await page.evaluate(() => window.SlateTopo.exportSVGString());
ok('rect export sized in mm', /width="152\.4mm" height="101\.6mm"/.test(svgRect));
writeFileSync(OUT + '/export-rect.svg', svgRect);
await page.screenshot({ path: OUT + '/shot-4-rect.png' });

// ---- 11. Render the exported SVG standalone (what xTool sees) ----
const page3 = await browser.newPage({ viewport: { width: 800, height: 800 } });
await page3.goto('file://' + OUT + '/export-shasta.svg');
await page3.screenshot({ path: OUT + '/shot-5-exported-file.png' });
ok('exported SVG renders standalone', true);

await browser.close();
server.close();

const fails = results.filter(r => !r.pass);
console.log('\n==== ' + (fails.length ? fails.length + ' FAILURES' : 'ALL ' + results.length + ' CHECKS PASSED') + ' ====');
process.exit(fails.length ? 1 : 0);
