/*
 * app.js — Slate Topo: contour-map SVG generator for laser engraving.
 *
 * Pipeline: AWS Open Data terrain tiles (Terrarium PNG encoding) -> elevation
 * grid -> optional smoothing -> marching-squares isolines -> geometric clipping
 * to the rounded border and around the label box -> SVG (mm units).
 *
 * All clipping is done to the actual path geometry, never with SVG clipPath:
 * laser software imports raw paths and ignores clip masks, so what you see in
 * the preview is exactly what the laser will trace.
 */
(function () {
  'use strict';

  const MM_PER_IN = 25.4;
  const GRID_W = 460;              // elevation samples across the map width
  const SIMPLIFY_MM = 0.06;        // path simplification tolerance
  const MIN_LINE_MM = 0.8;         // drop specks shorter than this
  const MAX_CONTOURS = 240;
  const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const DEM_ATTRIBUTION = 'Elevation: Terrain Tiles (Mapzen/AWS Open Data) — SRTM, USGS 3DEP, ETOPO1 and others';

  const C = window.ContourLib;
  const T = window.TextLib;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    lat: 41.4092,                 // Mount Shasta
    lon: -122.1949,
    areaMeters: 8 * 1609.344,     // ground distance across the map width
    areaUnit: 'mi',
    interval: 200, intervalUnit: 'ft',
    smoothing: 1,                 // grid blur radius (samples)
    lineWidth: 0.2,               // mm
    boldEvery: 0, boldWidth: 0.45,
    labelText: 'Mount Shasta\nElev: 14,179 Ft',
    fontId: 'roboto-slab',
    textSize: 5.5, textPad: 2.4,  // mm
    coasterW: 4, coasterH: 4,     // inches
    cornerRadius: 0.25,           // inches
    borderMargin: 0.15,           // inches
    borderWidth: 0.35,            // mm
    demo: false,
  };

  let terrain = null;      // { grid, gw, gh, minElev, maxElev }
  let merc = null;         // mercator window of the current terrain grid
  let geometry = null;     // last computed drawing (mm space)
  let terrainGen = 0;
  const blurCache = new Map();
  const tileCache = new Map();
  let contourCache = null; // chained, mm-space, pre-clip contour lines
  let warnings = [];

  const $ = id => document.getElementById(id);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // ---------------------------------------------------------------------------
  // Layout (mm)
  // ---------------------------------------------------------------------------
  function computeLayout() {
    const W = state.coasterW * MM_PER_IN, H = state.coasterH * MM_PER_IN;
    const m = clamp(state.borderMargin * MM_PER_IN, 0.5, Math.min(W, H) / 4);
    const bw = clamp(state.borderWidth, 0.1, 3);
    const border = {
      x: m, y: m, w: W - 2 * m, h: H - 2 * m,
      r: clamp(state.cornerRadius * MM_PER_IN, 0, Math.min(W - 2 * m, H - 2 * m) / 2),
    };
    const inset = bw / 2 + 0.25; // contours stop just inside the border line
    const clip = {
      x: border.x + inset, y: border.y + inset,
      w: border.w - 2 * inset, h: border.h - 2 * inset,
      r: Math.max(0, border.r - inset),
    };
    return { W, H, border, clip, bw };
  }

  // ---------------------------------------------------------------------------
  // Elevation data
  // ---------------------------------------------------------------------------
  function loadTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let p = tileCache.get(key);
    if (p) return p;
    p = fetch(TILE_URL(z, x, y), { mode: 'cors' })
      .then(resp => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.blob();
      })
      .then(blob => createImageBitmap(blob))
      .catch(err => { tileCache.delete(key); throw err; });
    tileCache.set(key, p);
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
    return p;
  }

  // Terrarium PNG: elevation m = (R * 256 + G + B / 256) - 32768
  function sampleGridFromImage(img, gw, gh, ox, oy, spanX, spanY) {
    const { data, width: mw, height: mh } = img;
    const grid = new Float32Array(gw * gh);
    const decode = (px, py) => {
      const xi = clamp(px, 0, mw - 1), yi = clamp(py, 0, mh - 1);
      const i = (yi * mw + xi) * 4;
      return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    };
    for (let j = 0; j < gh; j++) {
      const py = oy + spanY * (gh === 1 ? 0 : j / (gh - 1)) - 0.5;
      const y0 = Math.floor(py), fy = py - y0;
      for (let i = 0; i < gw; i++) {
        const px = ox + spanX * (gw === 1 ? 0 : i / (gw - 1)) - 0.5;
        const x0 = Math.floor(px), fx = px - x0;
        const v =
          decode(x0, y0) * (1 - fx) * (1 - fy) +
          decode(x0 + 1, y0) * fx * (1 - fy) +
          decode(x0, y0 + 1) * (1 - fx) * fy +
          decode(x0 + 1, y0 + 1) * fx * fy;
        grid[j * gw + i] = v;
      }
    }
    return grid;
  }

  async function fetchElevationGrid(gw, gh, aspect, gen) {
    const latR = clamp(state.lat, -85, 85) * Math.PI / 180;
    const areaM = state.areaMeters;
    let zoom = Math.round(Math.log2(156543.03392 * Math.cos(latR) * gw / areaM));
    zoom = clamp(zoom, 2, 15);
    const worldPx = 256 * Math.pow(2, zoom);
    const mpp = 156543.03392 * Math.cos(latR) / Math.pow(2, zoom);
    const cx = (state.lon + 180) / 360 * worldPx;
    const s = Math.sin(latR);
    const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
    const halfW = areaM / 2 / mpp, halfH = halfW * aspect;
    const px0 = cx - halfW, px1 = cx + halfW, py0 = cy - halfH, py1 = cy + halfH;

    const n = Math.pow(2, zoom);
    const tx0 = Math.floor(px0 / 256), tx1 = Math.floor(px1 / 256);
    const ty0 = clamp(Math.floor(py0 / 256), 0, n - 1), ty1 = clamp(Math.floor(py1 / 256), 0, n - 1);
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx = ((tx % n) + n) % n; // wrap across the antimeridian
        jobs.push(loadTile(zoom, wx, ty).then(
          img => ({ img, tx, ty }),
          err => ({ err, tx, ty })
        ));
      }
    }
    const results = await Promise.all(jobs);
    if (gen !== terrainGen) return null;

    const mw = (tx1 - tx0 + 1) * 256, mh = (ty1 - ty0 + 1) * 256;
    const canvas = document.createElement('canvas');
    canvas.width = mw; canvas.height = mh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(128,0,0)'; // terrarium encoding of 0 m
    ctx.fillRect(0, 0, mw, mh);
    let ok = 0, failed = 0;
    for (const r of results) {
      if (r.img) { ctx.drawImage(r.img, (r.tx - tx0) * 256, (r.ty - ty0) * 256); ok++; }
      else failed++;
    }
    if (!ok) throw new Error('No elevation tiles could be loaded — check your internet connection.');
    if (failed) warnings.push(failed + ' elevation tile(s) failed to load; part of the map may be flat.');

    const img = ctx.getImageData(0, 0, mw, mh);
    const grid = sampleGridFromImage(img, gw, gh, px0 - tx0 * 256, py0 - ty0 * 256, px1 - px0, py1 - py0);
    merc = { zoom, worldPx, cx, cy, mpp, px0, px1, py0, py1 };
    return grid;
  }

  function buildDemoGrid(gw, gh) {
    const g = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const u = i / (gw - 1), v = j / (gh - 1);
        const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
        const r = Math.hypot(x, y), th = Math.atan2(y, x);
        let e = 950 + 3350 * Math.exp(-Math.pow(r * 2.05, 2)) *
          (1 + 0.13 * Math.sin(5 * th + 1.7) + 0.05 * Math.sin(9 * th - 0.6));
        e += 240 * Math.sin(3.1 * x + 0.8) * Math.cos(2.7 * y - 0.4);
        e += 110 * Math.sin(7.3 * x - 1.1) * Math.sin(6.9 * y + 2.0);
        e += 45 * Math.sin(13.7 * x + 3.1) * Math.cos(11.3 * y + 1.2);
        g[j * gw + i] = e;
      }
    }
    merc = null;
    return g;
  }

  async function rebuildTerrain() {
    const gen = ++terrainGen;
    setLoading(true);
    hideBanner();
    warnings = [];
    try {
      const geom = computeLayout();
      const aspect = geom.border.h / geom.border.w;
      const gw = GRID_W;
      const gh = Math.max(24, Math.round(gw * aspect));
      const grid = state.demo ? buildDemoGrid(gw, gh) : await fetchElevationGrid(gw, gh, aspect, gen);
      if (gen !== terrainGen || !grid) return;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < grid.length; i++) {
        const v = grid[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      terrain = { grid, gw, gh, minElev: mn, maxElev: mx };
      blurCache.clear();
      contourCache = null;
      redraw();
    } catch (e) {
      if (gen !== terrainGen) return;
      showBanner(
        'Could not load elevation data: ' + e.message,
        state.demo ? null : { label: 'Use demo terrain', action: () => { state.demo = true; $('demo-mode').checked = true; rebuildTerrain(); } }
      );
    } finally {
      if (gen === terrainGen) setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Contours (cached pre-clip so label edits stay snappy)
  // ---------------------------------------------------------------------------
  function intervalMeters() {
    return state.intervalUnit === 'ft' ? state.interval * 0.3048 : state.interval;
  }

  function ensureContours(geom) {
    const intM = intervalMeters();
    const key = [state.smoothing, intM, terrain.gw, terrain.gh,
      geom.border.x, geom.border.y, geom.border.w, geom.border.h].join('|');
    if (contourCache && contourCache.key === key) return contourCache;

    let z = blurCache.get(state.smoothing);
    if (!z) {
      z = C.blurGrid(terrain.grid, terrain.gw, terrain.gh, state.smoothing);
      blurCache.set(state.smoothing, z);
    }
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < z.length; i++) {
      const v = z[i];
      if (v < zmin) zmin = v;
      if (v > zmax) zmax = v;
    }
    const kmin = Math.ceil(zmin / intM), kmax = Math.floor(zmax / intM);
    const count = kmax - kmin + 1;
    const levels = [];
    const cacheWarnings = [];
    if (count > MAX_CONTOURS) {
      cacheWarnings.push('Interval would draw ' + count + ' contour lines — increase the interval (showing none).');
    } else if (count > 120) {
      cacheWarnings.push(count + ' contour lines — very dense; consider a larger interval for slate.');
    }
    if (count > 0 && count <= MAX_CONTOURS) {
      for (let k = kmin; k <= kmax; k++) levels.push(k);
    }
    const eps = intM * 1e-6 + 1e-6; // dodge exact grid-value equality
    const thresholds = levels.map(k => k * intM + eps);
    const segs = C.marchingSquares(z, terrain.gw, terrain.gh, thresholds);
    const sx = geom.border.w / (terrain.gw - 1), sy = geom.border.h / (terrain.gh - 1);
    const perLevel = [];
    for (let i = 0; i < levels.length; i++) {
      const chains = C.chainSegments(segs[i]);
      const lines = chains.map(pts => pts.map(p => [geom.border.x + p[0] * sx, geom.border.y + p[1] * sy]));
      perLevel.push({ k: levels[i], lines });
    }
    contourCache = { key, intM, perLevel, zmin, zmax, warnings: cacheWarnings };
    return contourCache;
  }

  function redraw() {
    if (!terrain) return;
    const t0 = performance.now();
    warnings = warnings.filter(w => w.includes('tile')); // keep tile warnings, drop stale ones
    const geom = computeLayout();
    if (!(intervalMeters() > 0)) return;
    const cc = ensureContours(geom);
    warnings.push.apply(warnings, cc.warnings);

    // Label layout + knockout box
    let label = null;
    if (T.hasFonts()) {
      label = T.layoutLabel({
        text: state.labelText,
        fontId: state.fontId,
        sizeMm: clamp(state.textSize, 1.5, 30),
        padMm: clamp(state.textPad, 0.4, 15),
        left: geom.border.x + geom.bw / 2 + 2.0,
        bottom: geom.border.y + geom.border.h - geom.bw / 2 - 2.0,
      });
      if (label && label.box.w > geom.clip.w * 0.9) {
        warnings.push('Label is nearly as wide as the coaster — shorten the text or reduce its size.');
      }
    } else if (state.labelText.trim()) {
      warnings.push('Fonts failed to load — label omitted.');
    }
    const knock = label ? label.box : null;

    const insideClip = (x, y) => C.sdRoundRect(x, y, geom.clip) <= 0;
    const outsideKnock = knock ? ((x, y) => !C.insideRect(x, y, knock)) : null;

    const contours = [];
    let lineCount = 0, ptCount = 0, dBytes = 0;
    for (const lvl of cc.perLevel) {
      let lines = C.clipPolylines(lvl.lines, insideClip);
      if (outsideKnock) lines = C.clipPolylines(lines, outsideKnock);
      lines = lines
        .map(pts => C.simplifyLine(pts, SIMPLIFY_MM))
        .filter(pts => pts.length > 1 && C.polylineLength(pts) >= MIN_LINE_MM);
      if (!lines.length) continue;
      const d = C.polylinesToPathData(lines);
      const bold = state.boldEvery > 0 && ((lvl.k % state.boldEvery) + state.boldEvery) % state.boldEvery === 0;
      const elevM = lvl.k * cc.intM;
      contours.push({ elevM, bold, d });
      lineCount += lines.length;
      for (const l of lines) ptCount += l.length;
      dBytes += d.length;
    }

    geometry = {
      geom, contours, label,
      stats: {
        zmin: cc.zmin, zmax: cc.zmax,
        rawMin: terrain.minElev, rawMax: terrain.maxElev,
        levels: contours.length, lineCount, ptCount, dBytes,
        ms: performance.now() - t0,
      },
    };
    renderPreview();
    renderStats();
    saveHashSoon();
  }

  // ---------------------------------------------------------------------------
  // Preview + stats
  // ---------------------------------------------------------------------------
  function renderPreview() {
    const g = geometry;
    if (!g) return;
    const f = C.fmt;
    const { geom } = g;
    const thin = g.contours.filter(c => !c.bold);
    const bold = g.contours.filter(c => c.bold);
    const parts = [];
    parts.push(`<svg id="preview-svg" viewBox="0 0 ${f(geom.W)} ${f(geom.H)}" xmlns="http://www.w3.org/2000/svg">`);
    parts.push(`<rect class="pv-slate" x="0" y="0" width="${f(geom.W)}" height="${f(geom.H)}" rx="3"/>`);
    parts.push(`<g class="pv-map">`);
    if (thin.length) {
      parts.push(`<g class="pv-lines" fill="none" stroke-width="${f(Math.max(state.lineWidth, 0.16))}" stroke-linecap="round" stroke-linejoin="round">`);
      for (const c of thin) parts.push(`<path d="${c.d}"/>`);
      parts.push('</g>');
    }
    if (bold.length) {
      parts.push(`<g class="pv-lines" fill="none" stroke-width="${f(Math.max(state.boldWidth, 0.2))}" stroke-linecap="round" stroke-linejoin="round">`);
      for (const c of bold) parts.push(`<path d="${c.d}"/>`);
      parts.push('</g>');
    }
    parts.push('</g>');
    parts.push(`<path class="pv-border" fill="none" stroke-width="${f(geom.bw)}" d="${C.roundRectPath(geom.border)}"/>`);
    if (g.label) {
      parts.push('<g class="pv-label" stroke="none">');
      for (const d of g.label.paths) parts.push(`<path d="${d}"/>`);
      parts.push('</g>');
    }
    parts.push('</svg>');
    $('preview-wrap').querySelector('.pv-holder').innerHTML = parts.join('');
    $('size-caption').textContent =
      `${state.coasterW}″ × ${state.coasterH}″  ·  ${f(geom.W)} × ${f(geom.H)} mm`;
  }

  function fmtElev(m) {
    const v = state.intervalUnit === 'ft' ? m / 0.3048 : m;
    return Math.round(v).toLocaleString('en-US') + (state.intervalUnit === 'ft' ? ' ft' : ' m');
  }

  function renderStats() {
    const s = geometry && geometry.stats;
    if (!s) return;
    const bits = [];
    if (terrain) bits.push(`Elevation ${fmtElev(s.rawMin)} – ${fmtElev(s.rawMax)}`);
    bits.push(`${s.levels} contour levels · ${s.lineCount} lines`);
    bits.push(`≈ ${(s.dBytes / 1024).toFixed(0)} KB SVG`);
    if (merc) bits.push(`tiles z${merc.zoom}`);
    if (state.demo) bits.push('demo terrain');
    $('stats').textContent = bits.join('  ·  ');
    const w = $('warnings');
    w.innerHTML = '';
    for (const msg of warnings) {
      const div = document.createElement('div');
      div.className = 'warn';
      div.textContent = msg;
      w.appendChild(div);
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  function escapeXml(s) {
    return s.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
  }

  function exportSVGString() {
    const g = geometry;
    if (!g) return null;
    const f = C.fmt;
    const { geom } = g;
    const meta = {
      generator: 'Slate Topo',
      lat: state.lat, lon: state.lon,
      areaMeters: Math.round(state.areaMeters),
      interval: state.interval + ' ' + state.intervalUnit,
      size: state.coasterW + 'x' + state.coasterH + ' in',
      demo: state.demo || undefined,
      attribution: DEM_ATTRIBUTION,
    };
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(geom.W)}mm" height="${f(geom.H)}mm" viewBox="0 0 ${f(geom.W)} ${f(geom.H)}">`);
    parts.push(`<desc>${escapeXml(JSON.stringify(meta))}</desc>`);
    const thin = g.contours.filter(c => !c.bold);
    const bold = g.contours.filter(c => c.bold);
    if (thin.length) {
      parts.push(`<g id="contours" fill="none" stroke="#000000" stroke-width="${f(state.lineWidth)}" stroke-linecap="round" stroke-linejoin="round">`);
      for (const c of thin) parts.push(`<path data-elev="${fmtElev(c.elevM)}" d="${c.d}"/>`);
      parts.push('</g>');
    }
    if (bold.length) {
      parts.push(`<g id="contours-index" fill="none" stroke="#000000" stroke-width="${f(state.boldWidth)}" stroke-linecap="round" stroke-linejoin="round">`);
      for (const c of bold) parts.push(`<path data-elev="${fmtElev(c.elevM)}" d="${c.d}"/>`);
      parts.push('</g>');
    }
    parts.push(`<path id="border" fill="none" stroke="#000000" stroke-width="${f(geom.bw)}" d="${C.roundRectPath(geom.border)}"/>`);
    if (g.label && g.label.paths.length) {
      parts.push('<g id="label" fill="#000000" stroke="none">');
      for (const d of g.label.paths) parts.push(`<path d="${d}"/>`);
      parts.push('</g>');
    }
    parts.push('</svg>');
    return parts.join('\n');
  }

  function downloadSVG() {
    const svg = exportSVGString();
    if (!svg) return;
    const firstLine = (state.labelText.split('\n')[0] || 'contour-map').trim();
    const slug = (firstLine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'contour-map');
    const name = `${slug}-${state.coasterW}x${state.coasterH}in.svg`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------------------
  // UI chrome: banner / loading
  // ---------------------------------------------------------------------------
  function showBanner(msg, action) {
    const b = $('banner');
    b.innerHTML = '';
    b.appendChild(document.createTextNode(msg + ' '));
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.addEventListener('click', action.action);
      b.appendChild(btn);
    }
    b.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; }
  function setLoading(on) { $('loading').classList.toggle('on', on); }

  // ---------------------------------------------------------------------------
  // Location search (Nominatim / OpenStreetMap)
  // ---------------------------------------------------------------------------
  async function doSearch() {
    const q = $('search-input').value.trim();
    const box = $('search-results');
    if (!q) return;
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      setCenter(parseFloat(m[1]), parseFloat(m[2]));
      box.innerHTML = '';
      return;
    }
    box.innerHTML = '<div class="hint">Searching…</div>';
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(q);
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const arr = await resp.json();
      box.innerHTML = '';
      if (!arr.length) {
        box.innerHTML = '<div class="hint">No results — try adding a state/country, or paste "lat, lon".</div>';
        return;
      }
      for (const r of arr) {
        const btn = document.createElement('button');
        btn.className = 'result';
        btn.textContent = r.display_name;
        btn.addEventListener('click', () => {
          box.innerHTML = '';
          const shortName = r.display_name.split(',')[0].trim();
          if (shortName && $('label-text').value === '') {
            state.labelText = shortName;
            $('label-text').value = shortName;
          }
          setCenter(parseFloat(r.lat), parseFloat(r.lon));
        });
        box.appendChild(btn);
      }
    } catch (e) {
      box.innerHTML = '<div class="hint">Search failed (' + escapeXml(e.message) + '). Enter coordinates manually.</div>';
    }
  }

  function setCenter(lat, lon) {
    state.lat = clamp(lat, -85, 85);
    state.lon = ((lon + 180) % 360 + 360) % 360 - 180;
    $('lat').value = state.lat.toFixed(5);
    $('lon').value = state.lon.toFixed(5);
    rebuildTerrain();
  }

  // ---------------------------------------------------------------------------
  // Helpers wired to buttons
  // ---------------------------------------------------------------------------
  function insertPeakElevation() {
    if (!terrain) return;
    const ft = state.intervalUnit === 'ft';
    const val = Math.round(ft ? terrain.maxElev / 0.3048 : terrain.maxElev);
    const txt = 'Elev: ' + val.toLocaleString('en-US') + (ft ? ' Ft' : ' m');
    const lines = state.labelText ? state.labelText.split('\n') : [];
    const i = lines.findIndex(l => /^\s*elev/i.test(l));
    if (i >= 0) lines[i] = txt; else lines.push(txt);
    state.labelText = lines.join('\n');
    $('label-text').value = state.labelText;
    redraw();
  }

  function autoInterval() {
    if (!terrain) return;
    const reliefM = terrain.maxElev - terrain.minElev;
    if (reliefM <= 1) return;
    const relief = state.intervalUnit === 'ft' ? reliefM / 0.3048 : reliefM;
    const target = relief / 45; // aim for ~45 lines
    let best = Infinity;
    for (let p = -1; p < 6; p++) {
      for (const nn of [1, 2, 2.5, 5]) {
        const v = nn * Math.pow(10, p);
        if (v >= target && v < best) best = v;
      }
    }
    if (!isFinite(best)) return;
    state.interval = best;
    $('interval').value = best;
    redraw();
  }

  function areaUnitFactor() { return state.areaUnit === 'mi' ? 1609.344 : 1000; }

  function refreshAreaInput() {
    $('area').value = (state.areaMeters / areaUnitFactor()).toFixed(2).replace(/\.?0+$/, '');
  }

  function zoomBy(factor) {
    state.areaMeters = clamp(state.areaMeters * factor, 400, 500000);
    refreshAreaInput();
    scheduleRebuild();
  }

  // ---------------------------------------------------------------------------
  // Pan / zoom on the preview
  // ---------------------------------------------------------------------------
  function attachPreviewInteractions() {
    const wrap = $('preview-wrap');
    let drag = null;

    wrap.addEventListener('pointerdown', e => {
      if (!merc || !geometry) return;
      const svg = wrap.querySelector('#preview-svg');
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      drag = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY,
        pxPerMm: rect.width / geometry.geom.W,
        merc: Object.assign({}, merc),
        moved: false,
      };
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('dragging');
    });

    wrap.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dxmm = (e.clientX - drag.x0) / drag.pxPerMm;
      const dymm = (e.clientY - drag.y0) / drag.pxPerMm;
      if (Math.abs(dxmm) + Math.abs(dymm) > 0.3) drag.moved = true;
      const gmap = wrap.querySelector('.pv-map');
      if (gmap) gmap.setAttribute('transform', `translate(${dxmm} ${dymm})`);
    });

    function endDrag(e, commit) {
      if (!drag || e.pointerId !== drag.id) return;
      wrap.classList.remove('dragging');
      const d = drag; drag = null;
      const gmap = wrap.querySelector('.pv-map');
      if (gmap) gmap.removeAttribute('transform');
      if (!commit || !d.moved || !geometry) return;
      const dxmm = (e.clientX - d.x0) / d.pxPerMm;
      const dymm = (e.clientY - d.y0) / d.pxPerMm;
      const mercPxPerMm = (d.merc.px1 - d.merc.px0) / geometry.geom.border.w;
      const ncx = d.merc.cx - dxmm * mercPxPerMm;
      const ncy = d.merc.cy - dymm * mercPxPerMm;
      const lon = ncx / d.merc.worldPx * 360 - 180;
      const yy = 0.5 - ncy / d.merc.worldPx;
      const lat = Math.atan(Math.sinh(2 * Math.PI * yy)) * 180 / Math.PI;
      state.lat = clamp(lat, -85, 85);
      state.lon = ((lon + 180) % 360 + 360) % 360 - 180;
      $('lat').value = state.lat.toFixed(5);
      $('lon').value = state.lon.toFixed(5);
      rebuildTerrain();
    }
    wrap.addEventListener('pointerup', e => endDrag(e, true));
    wrap.addEventListener('pointercancel', e => endDrag(e, false));

    wrap.addEventListener('wheel', e => {
      if (!terrain || state.demo) return;
      e.preventDefault();
      zoomBy(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
  }

  // ---------------------------------------------------------------------------
  // Settings persistence in the URL hash
  // ---------------------------------------------------------------------------
  const HASH_FIELDS = ['lat', 'lon', 'areaMeters', 'areaUnit', 'interval', 'intervalUnit',
    'smoothing', 'lineWidth', 'boldEvery', 'boldWidth', 'labelText', 'fontId', 'textSize',
    'textPad', 'coasterW', 'coasterH', 'cornerRadius', 'borderMargin', 'borderWidth'];

  const saveHashSoon = debounce(() => {
    const o = {};
    for (const k of HASH_FIELDS) o[k] = state[k];
    try {
      const enc = btoa(unescape(encodeURIComponent(JSON.stringify(o))));
      history.replaceState(null, '', '#s=' + enc);
    } catch (e) { /* non-critical */ }
  }, 500);

  function loadHash() {
    const m = location.hash.match(/#s=(.+)/);
    if (!m) return;
    try {
      const o = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      for (const k of HASH_FIELDS) {
        if (k in o && typeof o[k] === typeof state[k]) state[k] = o[k];
      }
    } catch (e) { /* ignore bad hash */ }
  }

  // ---------------------------------------------------------------------------
  // Input wiring
  // ---------------------------------------------------------------------------
  const scheduleRebuild = debounce(rebuildTerrain, 300);
  const scheduleRedraw = debounce(redraw, 120);

  function bindNumber(id, key, opts) {
    const el = $(id);
    el.value = state[key];
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isFinite(v)) return;
      state[key] = opts.min !== undefined ? clamp(v, opts.min, opts.max) : v;
      if (opts.rebuild) scheduleRebuild(); else scheduleRedraw();
    });
  }

  function init() {
    loadHash();
    if (/[?&]demo=1/.test(location.search)) state.demo = true;

    const fontErrors = T.initFonts(window.SLATE_FONTS || [], window.opentype);
    if (fontErrors.length) console.warn('Font load errors:', fontErrors);
    const fsel = $('font');
    for (const f of T.fontIds()) {
      const opt = document.createElement('option');
      opt.value = f.id; opt.textContent = f.label;
      fsel.appendChild(opt);
    }
    if (T.fontIds().some(f => f.id === state.fontId)) fsel.value = state.fontId;
    else if (T.fontIds().length) state.fontId = fsel.value = T.fontIds()[0].id;

    bindNumber('lat', 'lat', { min: -85, max: 85, rebuild: true });
    bindNumber('lon', 'lon', { min: -180, max: 180, rebuild: true });
    bindNumber('interval', 'interval', { min: 0.5, max: 5000 });
    bindNumber('line-width', 'lineWidth', { min: 0.05, max: 2 });
    bindNumber('bold-every', 'boldEvery', { min: 0, max: 20 });
    bindNumber('bold-width', 'boldWidth', { min: 0.05, max: 2 });
    bindNumber('text-size', 'textSize', { min: 1.5, max: 30 });
    bindNumber('text-pad', 'textPad', { min: 0.4, max: 15 });
    bindNumber('coaster-w', 'coasterW', { min: 1, max: 24, rebuild: true });
    bindNumber('coaster-h', 'coasterH', { min: 1, max: 24, rebuild: true });
    bindNumber('corner-radius', 'cornerRadius', { min: 0, max: 6 });
    bindNumber('border-margin', 'borderMargin', { min: 0.02, max: 2, rebuild: true });
    bindNumber('border-width', 'borderWidth', { min: 0.1, max: 3 });

    refreshAreaInput();
    $('area').addEventListener('input', () => {
      const v = parseFloat($('area').value);
      if (!isFinite(v) || v <= 0) return;
      state.areaMeters = clamp(v * areaUnitFactor(), 400, 500000);
      scheduleRebuild();
    });
    $('area-unit').value = state.areaUnit;
    $('area-unit').addEventListener('change', () => {
      state.areaUnit = $('area-unit').value;
      refreshAreaInput();
    });
    $('zoom-in').addEventListener('click', () => zoomBy(0.8));
    $('zoom-out').addEventListener('click', () => zoomBy(1.25));

    $('interval-unit').value = state.intervalUnit;
    $('interval-unit').addEventListener('change', () => {
      state.intervalUnit = $('interval-unit').value;
      redraw();
    });
    $('auto-interval').addEventListener('click', autoInterval);

    $('smoothing').value = state.smoothing;
    $('smoothing').addEventListener('input', () => {
      state.smoothing = parseInt($('smoothing').value, 10) || 0;
      scheduleRedraw();
    });

    $('label-text').value = state.labelText;
    $('label-text').addEventListener('input', () => {
      state.labelText = $('label-text').value;
      scheduleRedraw();
    });
    fsel.addEventListener('change', () => { state.fontId = fsel.value; redraw(); });
    $('peak-btn').addEventListener('click', insertPeakElevation);

    $('search-btn').addEventListener('click', doSearch);
    $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    $('demo-mode').checked = state.demo;
    $('demo-mode').addEventListener('change', () => {
      state.demo = $('demo-mode').checked;
      rebuildTerrain();
    });

    $('download-btn').addEventListener('click', downloadSVG);

    attachPreviewInteractions();
    rebuildTerrain();
  }

  // Exposed for tests and console tinkering
  window.SlateTopo = {
    state,
    get geometry() { return geometry; },
    get terrain() { return terrain; },
    exportSVGString, rebuildTerrain, redraw, computeLayout,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
