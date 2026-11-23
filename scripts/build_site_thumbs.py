#!/usr/bin/env python3
"""Draw the small pictures of what stands at a landing site (the strip along the site view): one sheet of renders.

python3 scripts/build_site_thumbs.py     writes zimi/static/earth/site-thumbs-v1.webp and the sheet's table into sites-v1.json

The models are every site's parts (craft-site-<model>-v1.bin), drawn as the Sent pill's thumbnails are
(scripts/build_sent_thumbs.py render): three-quarters above, lit from the upper left, on a transparent ground. The cells run
left to right, top to bottom in the order of the "thumbs" list in sites-v1.json (written here).
"""

import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_sent_thumbs as bst  # noqa: E402

SITES = os.path.join(bst.EARTH_DIR, "sites-v1.json")
OUT = os.path.join(bst.EARTH_DIR, "site-thumbs-v1.webp")
COLS = 6


def parts_models(data):
    """Every model a site stands, a rover by its body, in the order they first appear."""
    seen = []
    for s in data["sites"]:
        for p in s["parts"]:
            m = data["rovers"][p["m"]]["body"] if p["m"] in data["rovers"] else p["m"]
            if m not in seen:
                seen.append(m)
    return seen


def main():
    with open(SITES, encoding="utf-8") as fh:
        data = json.load(fh)
    ms = parts_models(data)
    rows = -(-len(ms) // COLS)
    sheet = Image.new("RGBA", (COLS * bst.CELL_PX, rows * bst.CELL_PX), (0, 0, 0, 0))
    for i, m in enumerate(ms):
        from PIL import Image as _I
        sheet.paste(_I.fromarray(bst.render(m), "RGBA"), ((i % COLS) * bst.CELL_PX, (i // COLS) * bst.CELL_PX))
    sheet.save(OUT, "WEBP", quality=76, method=6)
    data["thumbs"] = {"cols": COLS, "models": ms}
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_site_models as bsm
    with open(SITES, "w", encoding="utf-8") as fh:
        fh.write(bsm.dump_compact(data))
    print(OUT, os.path.getsize(OUT), "bytes", len(ms), "models")


if __name__ == "__main__":
    main()
