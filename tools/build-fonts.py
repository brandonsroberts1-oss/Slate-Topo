#!/usr/bin/env python3
"""Regenerate vendor/fonts-data.js.

Downloads TTFs from the Google Fonts CSS API (requesting without a browser
User-Agent returns plain TTF URLs) and embeds them as base64 so the app works
offline and from file://. Run from the repo root:

    python3 tools/build-fonts.py
"""
import base64
import json
import re
import urllib.request

FONTS = [
    # (family query, id, label)
    ("Roboto+Slab:wght@500", "roboto-slab", "Roboto Slab (slab serif)"),
    ("Roboto:wght@500", "roboto", "Roboto (clean sans)"),
    ("Pacifico", "pacifico", "Pacifico (script)"),
]

CSS_URL = "https://fonts.googleapis.com/css2?family={}"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as r:
        return r.read()


def main() -> None:
    out = [
        "// Embedded fonts (base64 TTF). Generated from Google Fonts downloads.",
        "// See vendor/LICENSES.md for font licenses. Regenerate with tools/build-fonts.py",
        "window.SLATE_FONTS = [",
    ]
    for family, fid, label in FONTS:
        css = fetch(CSS_URL.format(family)).decode()
        m = re.search(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", css)
        if not m:
            raise SystemExit(f"no font URL found for {family}")
        ttf = fetch(m.group(1))
        b64 = base64.b64encode(ttf).decode()
        out.append(json.dumps({"id": fid, "label": label, "base64": b64}) + ",")
        print(f"{fid}: {len(ttf)} bytes from {m.group(1)}")
    out.append("];")
    with open("vendor/fonts-data.js", "w") as f:
        f.write("\n".join(out))
    print("wrote vendor/fonts-data.js")


if __name__ == "__main__":
    main()
