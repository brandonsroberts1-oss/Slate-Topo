/*
 * text.js — label engine for Slate Topo.
 * Parses the embedded fonts with opentype.js and lays out the corner label:
 * every glyph becomes an SVG <path>, so the exported file needs no fonts and
 * imports into laser software (xTool Creative Space, LightBurn, …) unchanged.
 * The label box auto-sizes to the text.
 */
(function (global) {
  'use strict';

  const fonts = new Map(); // id -> { font, label }
  let fallbackId = null;

  function base64ToArrayBuffer(b64) {
    const bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function initFonts(fontList, opentypeLib) {
    const errors = [];
    for (const f of fontList) {
      try {
        const font = opentypeLib.parse(base64ToArrayBuffer(f.base64));
        fonts.set(f.id, { font, label: f.label });
        if (!fallbackId) fallbackId = f.id;
      } catch (e) {
        errors.push(f.id + ': ' + e.message);
      }
    }
    return errors;
  }

  function fontIds() {
    return Array.from(fonts.entries()).map(([id, v]) => ({ id, label: v.label }));
  }

  /*
   * Lay out the label anchored at a bottom-left point.
   * opts: {
   *   text        multi-line string
   *   fontId
   *   sizeMm      font size (em size) in mm
   *   padMm       padding between text and knockout-box edge
   *   left        x of the box's left edge (mm)
   *   bottom      y of the box's bottom edge (mm)
   *   lineHeight  multiple of sizeMm (default 1.28)
   * }
   * Returns null when there is no text, else:
   *   { paths: [d, ...], box: {x, y, w, h}, lineCount }
   * box is the knockout rectangle (already includes padding).
   */
  function layoutLabel(opts) {
    const entry = fonts.get(opts.fontId) || fonts.get(fallbackId);
    if (!entry) return null;
    const font = entry.font;
    const size = opts.sizeMm;
    const pad = opts.padMm;
    const lineHeight = (opts.lineHeight || 1.28) * size;

    let lines = String(opts.text || '').split(/\r?\n/).map(s => s.replace(/\s+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    while (lines.length && lines[0] === '') lines.shift();
    if (!lines.length) return null;

    const upem = font.unitsPerEm;
    const asc = font.ascender / upem * size;
    const desc = font.descender / upem * size; // negative
    const widths = lines.map(l => l ? font.getAdvanceWidth(l, size, { kerning: true }) : 0);
    const maxW = Math.max.apply(null, widths);

    const boxW = maxW + 2 * pad;
    const boxH = 2 * pad + asc - desc + (lines.length - 1) * lineHeight;
    const boxX = opts.left;
    const boxY = opts.bottom - boxH;

    const paths = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const baseline = boxY + pad + asc + i * lineHeight;
      const p = font.getPath(lines[i], boxX + pad, baseline, size, { kerning: true });
      const d = p.toPathData(3);
      if (d) paths.push(d);
    }
    return { paths, box: { x: boxX, y: boxY, w: boxW, h: boxH }, lineCount: lines.length };
  }

  const api = { initFonts, fontIds, layoutLabel, hasFonts: () => fonts.size > 0 };
  global.TextLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
