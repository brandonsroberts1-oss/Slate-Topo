# Marketing images

Etsy-ready listing photos (3000 × 2250, 4:3 — Etsy's recommended size), generated
from real terrain by `generate.mjs`. Mix them with actual product photos in a
listing.

| File | Use |
| --- | --- |
| `etsy-1-hero.jpg` | Personalization callouts — arrows to every field a buyer can customize |
| `etsy-2-anywhere.jpg` | "Anywhere you love, mapped" — Shasta, Mont Blanc, Tahoe, Grand Canyon |
| `etsy-3-make-it-yours.jpg` | The three lettering styles and the auto-sizing text panel |
| `etsy-4-how-it-works.jpg` | Three-step story: pick a place → mapped → engraved |

The renders are illustrative mockups (chipped-slate look built in SVG); the
engraving artwork itself is the app's real output for each location.

## Regenerating

Edit locations/captions in `generate.mjs`, then:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm i playwright --no-fund
OUT_DIR=$PWD/out node <repo>/marketing/generate.mjs
```

Tiles come from the live network by default; in an offline/sandboxed
environment prefetch them and pass `TILE_DIR` (see `.claude/skills/verify/SKILL.md`).
