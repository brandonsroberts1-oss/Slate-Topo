# Slate Topo

A small, self-contained web app that generates **contour-line map SVGs for laser
engraving** — made for engraving slate coasters (like a 4″ × 4″ Mont Blanc /
Mount Shasta coaster) with **xTool Creative Space**, but the output is plain SVG
that works in LightBurn and similar software too.

Type in coordinates (or search by name), frame the mountain, pick a contour
interval, edit the corner label, and download an SVG sized in real millimeters.

## Quick start

**Easiest way — one file:** download **`slate-topo.html`** and double-click it.
The entire app (styles, code, fonts) is inside that single file; only elevation
data is fetched from the internet. On GitHub: click `slate-topo.html` → the
**Download raw file** button (↓ icon, top right of the file view) → open the
downloaded file in your browser.

Running from the repo works too, but `index.html` needs its `css/`, `js/` and
`vendor/` folders next to it — so clone or download the **whole project** (green
**Code** button → Download ZIP → **extract it fully**), then:

1. Open `index.html` from inside the extracted folder (double-click works), or
   serve it:

   ```
   python3 -m http.server 8000
   # then visit http://localhost:8000
   ```

2. Search for a location (e.g. “Mount Shasta”) or type latitude/longitude.
3. Frame it: drag the preview to pan, scroll (or use the +/− buttons) to zoom.
4. Set the **contour interval** — the elevation difference between neighboring
   lines (e.g. 200 ft). **Auto** picks one that gives ≈45 lines.
5. Edit the label text (one row per line — the knockout box grows and shrinks
   with the text). **Insert peak elevation** fills in the highest point in view.
6. **Download SVG** and import it into xTool Creative Space.

Your current design is saved in the URL, so you can bookmark a design or share
it and get the exact same map back.

## Using the SVG in xTool Creative Space

- Import the file, then **check the size**: a 4″ coaster should read
  **101.6 × 101.6 mm**. The SVG declares real mm units; if your XCS version
  ignores them, set the size manually to the values shown under the preview.
- Contour lines + border: set processing to **Score**.
- Label text: the letters are filled vector paths — set them to **Engrave**.
- Slate tip: always run a small material test first; light engraving on slate
  turns pale gray/white, so scored lines look like the classic engraved look.

Things the app already guarantees for laser use:

- **Everything is a real path.** Text is converted to outlines with an embedded
  font (no `<text>` elements), so nothing depends on installed fonts.
- **Clipping is geometric, not visual.** Laser software ignores SVG masks, so
  the app actually cuts the polylines at the rounded border and removes them
  behind the label box — what you see is exactly what the laser traces.
- The border is a rounded rectangle inset from the coaster edge, like the
  classic engraved-coaster look.

## Options

| Control | Meaning |
| --- | --- |
| Map width | Ground distance across the map (mi/km) — the zoom level |
| Contour interval | Elevation difference per line (ft/m), aligned to sea level so lines sit at round elevations |
| Smoothing | Blurs the elevation grid for cleaner, more organic lines |
| Line / bold width | Stroke widths in mm; “bold every Nth” makes index contours heavier |
| Label text & size | Multi-line label, auto-sizing knockout box, three embedded fonts |
| Coaster size | Width/height in inches (default 4×4), engraved-border corner radius, border margin & width |

## Data & attribution

- Elevation: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on
  AWS Open Data (Mapzen terrarium tiles; sources include SRTM, USGS 3DEP,
  ETOPO1). Free, no API key.
- Location search: [Nominatim / OpenStreetMap](https://www.openstreetmap.org/copyright)
  (© OpenStreetMap contributors). Light, on-demand use only.
- If you have no internet connection, tick **Demo terrain** (or open
  `index.html?demo=1`) to play with a synthetic mountain.

## Troubleshooting

- **Plain black-and-white page, dead buttons, no map** (or an “App files
  didn’t load” message): you opened `index.html` without its folders — usually
  a lone downloaded file, or double-clicked inside a ZIP that wasn’t extracted.
  Use the single `slate-topo.html` file instead, or extract the whole project
  first.
- **“Could not load elevation data”**: no internet (or a firewall blocking
  `s3.amazonaws.com`). Tick **Demo terrain** to keep playing offline.
- **Wrong size in xTool Creative Space**: set width/height manually to the mm
  values shown under the preview (4″ = 101.6 mm).

## Repo layout

```
slate-topo.html       ← the whole app in ONE file (generated; download this)
index.html            app shell (needs css/ js/ vendor/ beside it)
css/style.css         styling
js/contour.js         marching squares, chaining, clipping, simplification
js/text.js            text → vector paths (opentype.js) + auto-sizing label box
js/app.js             UI, elevation tiles, pipeline, SVG export
vendor/opentype.min.js  opentype.js 1.3.4 (MIT)
vendor/fonts-data.js    embedded fonts (base64 TTF)
tools/build-fonts.py       regenerates vendor/fonts-data.js
tools/build-single-file.py regenerates slate-topo.html after code edits
```

See `vendor/LICENSES.md` for third-party licenses.
