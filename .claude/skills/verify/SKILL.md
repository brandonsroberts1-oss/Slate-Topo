# Verify Slate Topo

Static web app — no build step. Surface = the browser UI at `index.html`.

## Launch

```bash
python3 -m http.server 8000   # serve repo root, or open index.html directly
```

## Automated E2E drive

`e2e.mjs` in this directory drives the real UI with Playwright: loads the app,
checks contour rendering, export-geometry invariants (all points inside the
rounded border, none behind the label knockout), label auto-sizing, pan/zoom,
demo mode, and screenshots everything.

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm i playwright --no-fund
OUT_DIR=$PWD node <repo>/.claude/skills/verify/e2e.mjs
```

- Sandboxed/proxied environment (browser can't reach the internet): prefetch
  terrain tiles with curl into a dir of `{z}_{x}_{y}.png` files and pass
  `TILE_DIR=<dir>`; the script serves them via route interception so the app
  still exercises its real fetch→decode path. Without `TILE_DIR`, tile
  requests go to the live network (fine on a normal machine).
  Tile URL: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  (defaults need z12, x 655–659, y 1527–1531 — Mount Shasta).
- Chromium: pass `CHROMIUM_PATH` if Playwright's own download isn't present
  (in Claude's remote env: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).
- Offline-only check: open `index.html?demo=1` — synthetic mountain renders
  with zero network.

## What to eyeball in screenshots

`shot-1` preview should look like an engraved slate coaster: white contours on
dark slate, rounded border, label bottom-left with contour lines fully cleared
behind it. `shot-5` is the exported SVG rendered standalone (black on white) —
this is what xTool Creative Space imports.

## Gotchas

- Export must never contain `<text>`, `<clipPath>`, or `<image>` — laser
  software ignores clip masks and may substitute fonts. Clipping is geometric.
- The SVG root must carry real units: `width="101.6mm"` for a 4″ coaster.
- `window.SlateTopo` exposes `state`, `geometry`, `exportSVGString()` for
  driving checks from the console/page context.
