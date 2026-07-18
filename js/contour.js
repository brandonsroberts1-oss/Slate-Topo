/*
 * contour.js — geometry core for Slate Topo.
 * Pure functions, no DOM: elevation-grid smoothing, marching-squares isolines,
 * segment chaining, polyline clipping, and simplification.
 *
 * Everything here operates on plain arrays so it can also run under Node for tests.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Grid smoothing: 3-pass box blur ≈ Gaussian. radius in samples, 0 = off.
  // ---------------------------------------------------------------------------
  function boxBlurPass(src, dst, w, h, r, horizontal) {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const stride = horizontal ? 1 : w;
    const lineStride = horizontal ? w : 1;
    const norm = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const idx = Math.min(len - 1, Math.max(0, k));
        sum += src[base + idx * stride];
      }
      for (let i = 0; i < len; i++) {
        dst[base + i * stride] = sum * norm;
        const iAdd = Math.min(len - 1, i + r + 1);
        const iSub = Math.max(0, i - r);
        sum += src[base + iAdd * stride] - src[base + iSub * stride];
      }
    }
  }

  function blurGrid(data, w, h, radius) {
    const r = Math.round(radius);
    if (r <= 0) return Float32Array.from(data);
    let a = Float32Array.from(data);
    let b = new Float32Array(data.length);
    for (let pass = 0; pass < 3; pass++) {
      boxBlurPass(a, b, w, h, r, true);
      boxBlurPass(b, a, w, h, r, false);
    }
    return a;
  }

  // ---------------------------------------------------------------------------
  // Marching squares. Grid is row-major z[y*w+x], y increasing downward.
  // Returns one segment list per threshold: flat arrays [x1,y1,x2,y2, ...]
  // in grid coordinates. Thresholds must be sorted ascending.
  // ---------------------------------------------------------------------------
  function marchingSquares(z, w, h, thresholds) {
    const nt = thresholds.length;
    const segs = new Array(nt);
    for (let k = 0; k < nt; k++) segs[k] = [];
    if (nt === 0) return segs;

    // frac of threshold t between values a -> b (guarded)
    function f(t, a, b) {
      const d = b - a;
      if (d === 0) return 0.5;
      const v = (t - a) / d;
      return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    function push(out, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay;
      if (dx * dx + dy * dy < 1e-12) return; // degenerate
      out.push(ax, ay, bx, by);
    }

    // Find first threshold index >= value (binary search).
    function lowerBound(v) {
      let lo = 0, hi = nt;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (thresholds[mid] < v) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    for (let y = 0; y < h - 1; y++) {
      const row = y * w;
      for (let x = 0; x < w - 1; x++) {
        const tl = z[row + x], tr = z[row + x + 1];
        const bl = z[row + w + x], br = z[row + w + x + 1];
        let cmin = tl < tr ? tl : tr;
        let cmax = tl > tr ? tl : tr;
        if (bl < cmin) cmin = bl; if (bl > cmax) cmax = bl;
        if (br < cmin) cmin = br; if (br > cmax) cmax = br;

        for (let k = lowerBound(cmin); k < nt; k++) {
          const t = thresholds[k];
          if (t > cmax) break;
          let idx = 0;
          if (tl >= t) idx |= 1;
          if (tr >= t) idx |= 2;
          if (br >= t) idx |= 4;
          if (bl >= t) idx |= 8;
          if (idx === 0 || idx === 15) continue;

          // Edge intersection points
          // T: top, R: right, B: bottom, L: left
          let Tx, Ty, Rx, Ry, Bx, By, Lx, Ly;
          const out = segs[k];
          switch (idx) {
            case 1: case 14: // TL only / all but TL  -> L-T
              Lx = x; Ly = y + f(t, tl, bl);
              Tx = x + f(t, tl, tr); Ty = y;
              push(out, Lx, Ly, Tx, Ty);
              break;
            case 2: case 13: // TR -> T-R
              Tx = x + f(t, tl, tr); Ty = y;
              Rx = x + 1; Ry = y + f(t, tr, br);
              push(out, Tx, Ty, Rx, Ry);
              break;
            case 3: case 12: // TL,TR -> L-R
              Lx = x; Ly = y + f(t, tl, bl);
              Rx = x + 1; Ry = y + f(t, tr, br);
              push(out, Lx, Ly, Rx, Ry);
              break;
            case 4: case 11: // BR -> R-B
              Rx = x + 1; Ry = y + f(t, tr, br);
              Bx = x + f(t, bl, br); By = y + 1;
              push(out, Rx, Ry, Bx, By);
              break;
            case 6: case 9: // TR,BR / TL,BL -> T-B
              Tx = x + f(t, tl, tr); Ty = y;
              Bx = x + f(t, bl, br); By = y + 1;
              push(out, Tx, Ty, Bx, By);
              break;
            case 7: case 8: // all but BL / BL only -> L-B
              Lx = x; Ly = y + f(t, tl, bl);
              Bx = x + f(t, bl, br); By = y + 1;
              push(out, Lx, Ly, Bx, By);
              break;
            case 5: case 10: { // ambiguous saddles, resolve with center average
              Tx = x + f(t, tl, tr); Ty = y;
              Rx = x + 1; Ry = y + f(t, tr, br);
              Bx = x + f(t, bl, br); By = y + 1;
              Lx = x; Ly = y + f(t, tl, bl);
              const centerHigh = (tl + tr + br + bl) / 4 >= t;
              const bandTLBR = (idx === 5) === centerHigh;
              if (bandTLBR) { // high band connects TL-BR (or low band does for case 10)
                push(out, Tx, Ty, Rx, Ry);
                push(out, Lx, Ly, Bx, By);
              } else {
                push(out, Lx, Ly, Tx, Ty);
                push(out, Rx, Ry, Bx, By);
              }
              break;
            }
          }
        }
      }
    }
    return segs;
  }

  // ---------------------------------------------------------------------------
  // Chain segments into polylines. Input: flat [x1,y1,x2,y2,...].
  // Output: array of polylines, each an array of [x,y] points.
  // Endpoints from adjacent cells are bit-identical, so exact keys work,
  // but we quantize anyway for safety.
  // ---------------------------------------------------------------------------
  function chainSegments(flat) {
    const n = flat.length / 4;
    const map = new Map();
    const key = (x, y) => Math.round(x * 4096) + '|' + Math.round(y * 4096);
    for (let i = 0; i < n; i++) {
      const k0 = key(flat[i * 4], flat[i * 4 + 1]);
      const k1 = key(flat[i * 4 + 2], flat[i * 4 + 3]);
      let a = map.get(k0); if (!a) map.set(k0, a = []); a.push(i * 2);     // even = endpoint 0
      let b = map.get(k1); if (!b) map.set(k1, b = []); b.push(i * 2 + 1); // odd  = endpoint 1
    }
    const used = new Uint8Array(n);
    const lines = [];

    function takeFrom(x, y) {
      const arr = map.get(key(x, y));
      if (!arr) return -1;
      for (let j = 0; j < arr.length; j++) {
        const rec = arr[j];
        if (!used[rec >> 1]) { used[rec >> 1] = 1; return rec; }
      }
      return -1;
    }

    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const fwd = [[flat[i * 4], flat[i * 4 + 1]], [flat[i * 4 + 2], flat[i * 4 + 3]]];
      // extend forward from the tail
      for (;;) {
        const tail = fwd[fwd.length - 1];
        const rec = takeFrom(tail[0], tail[1]);
        if (rec < 0) break;
        const si = rec >> 1, other = (rec & 1) ? 0 : 1; // entered at rec&1, exit at other end
        fwd.push([flat[si * 4 + other * 2], flat[si * 4 + other * 2 + 1]]);
      }
      // extend backward from the head
      const back = [];
      for (;;) {
        const head = back.length ? back[back.length - 1] : fwd[0];
        const rec = takeFrom(head[0], head[1]);
        if (rec < 0) break;
        const si = rec >> 1, other = (rec & 1) ? 0 : 1;
        back.push([flat[si * 4 + other * 2], flat[si * 4 + other * 2 + 1]]);
      }
      back.reverse();
      lines.push(back.concat(fwd));
    }
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Signed distance to a rounded rectangle. rect = {x, y, w, h, r}. <= 0 inside.
  // ---------------------------------------------------------------------------
  function sdRoundRect(px, py, rect) {
    const r = Math.min(rect.r || 0, rect.w / 2, rect.h / 2);
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const qx = Math.abs(px - cx) - (rect.w / 2 - r);
    const qy = Math.abs(py - cy) - (rect.h / 2 - r);
    const ax = qx > 0 ? qx : 0, ay = qy > 0 ? qy : 0;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
  }

  function insideRect(px, py, rect) {
    return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
  }

  // ---------------------------------------------------------------------------
  // Clip polylines to the region where insideFn(x, y) is true.
  // Boundary crossings are refined by bisection. Segments are assumed short
  // relative to the region (true here: segments are ~1 grid cell long).
  // ---------------------------------------------------------------------------
  function clipPolylines(lines, insideFn) {
    const out = [];
    function crossing(ax, ay, bx, by) { // a outside-state differs from b; find boundary point
      let lo = 0, hi = 1;
      const aIn = insideFn(ax, ay);
      for (let it = 0; it < 22; it++) {
        const mid = (lo + hi) / 2;
        const mx = ax + (bx - ax) * mid, my = ay + (by - ay) * mid;
        if (insideFn(mx, my) === aIn) lo = mid; else hi = mid;
      }
      const m = (lo + hi) / 2;
      return [ax + (bx - ax) * m, ay + (by - ay) * m];
    }
    for (const line of lines) {
      let cur = null;
      let prev = line[0];
      let prevIn = insideFn(prev[0], prev[1]);
      if (prevIn) cur = [prev];
      for (let i = 1; i < line.length; i++) {
        const p = line[i];
        const pIn = insideFn(p[0], p[1]);
        if (pIn && prevIn) {
          cur.push(p);
        } else if (pIn && !prevIn) {
          cur = [crossing(prev[0], prev[1], p[0], p[1]), p];
        } else if (!pIn && prevIn) {
          cur.push(crossing(prev[0], prev[1], p[0], p[1]));
          if (cur.length > 1) out.push(cur);
          cur = null;
        }
        prev = p; prevIn = pIn;
      }
      if (cur && cur.length > 1) out.push(cur);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Douglas–Peucker simplification (iterative).
  // ---------------------------------------------------------------------------
  function simplifyLine(pts, eps) {
    const n = pts.length;
    if (n < 3) return pts;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    const eps2 = eps * eps;
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = pts[a][0], ay = pts[a][1];
      const bx = pts[b][0], by = pts[b][1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let maxD = -1, maxI = -1;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i][0] - ax, py = pts[i][1] - ay;
        let d;
        if (len2 === 0) {
          d = px * px + py * py;
        } else {
          let tt = (px * dx + py * dy) / len2;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const ex = px - tt * dx, ey = py - tt * dy;
          d = ex * ex + ey * ey;
        }
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > eps2) {
        keep[maxI] = 1;
        stack.push([a, maxI], [maxI, b]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  function polylineLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return L;
  }

  // ---------------------------------------------------------------------------
  // SVG path data for a rounded rectangle (arc corners), and for polylines.
  // ---------------------------------------------------------------------------
  function fmt(n) {
    const s = n.toFixed(2);
    return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, '');
  }

  function roundRectPath(rect) {
    const r = Math.min(rect.r || 0, rect.w / 2, rect.h / 2);
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    if (r <= 0.01) {
      return 'M' + fmt(x) + ' ' + fmt(y) + 'H' + fmt(x + w) + 'V' + fmt(y + h) + 'H' + fmt(x) + 'Z';
    }
    const a = 'A' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ';
    return 'M' + fmt(x + r) + ' ' + fmt(y) +
      'H' + fmt(x + w - r) + a + fmt(x + w) + ' ' + fmt(y + r) +
      'V' + fmt(y + h - r) + a + fmt(x + w - r) + ' ' + fmt(y + h) +
      'H' + fmt(x + r) + a + fmt(x) + ' ' + fmt(y + h - r) +
      'V' + fmt(y + r) + a + fmt(x + r) + ' ' + fmt(y) + 'Z';
  }

  function polylinesToPathData(lines) {
    const parts = [];
    for (const pts of lines) {
      if (pts.length < 2) continue;
      let closed = false;
      let end = pts.length;
      const p0 = pts[0], pn = pts[pts.length - 1];
      if (pts.length > 3 && Math.hypot(pn[0] - p0[0], pn[1] - p0[1]) < 0.02) {
        closed = true; end = pts.length - 1;
      }
      let d = 'M' + fmt(pts[0][0]) + ' ' + fmt(pts[0][1]);
      for (let i = 1; i < end; i++) d += 'L' + fmt(pts[i][0]) + ' ' + fmt(pts[i][1]);
      if (closed) d += 'Z';
      parts.push(d);
    }
    return parts.join('');
  }

  const api = {
    blurGrid, marchingSquares, chainSegments,
    sdRoundRect, insideRect, clipPolylines,
    simplifyLine, polylineLength, roundRectPath, polylinesToPathData, fmt,
  };
  global.ContourLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
