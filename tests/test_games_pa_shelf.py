"""The shelf's art: every tile has a drawing, not a flat colour.

Snap's tile was a green rectangle (thumbs/snap.svg, 141 bytes) beside the drawn tiles of its neighbours.

Run: pytest tests/test_games_pa_shelf.py -v
"""

import os
import re

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
THUMBS = os.path.join(GAMES, "thumbs")
MIN_DRAWN_ELEMENTS = 4  # a background rectangle and at least three shapes on it


def drawn_elements(svg):
    return len(re.findall(r"<(?!/|\?|!)(?!svg\b)[a-zA-Z]", svg))


def test_every_thumbnail_is_a_drawing_not_a_flat_colour():
    flat = []
    for name in sorted(os.listdir(THUMBS)):
        if not name.endswith(".svg"):
            continue
        with open(os.path.join(THUMBS, name), encoding="utf-8") as f:
            svg = f.read()
        if drawn_elements(svg) < MIN_DRAWN_ELEMENTS:
            flat.append((name, drawn_elements(svg)))
    assert not flat, "tiles with no drawing on them: %s" % flat


def test_every_shelf_tile_has_its_thumbnail():
    with open(os.path.join(GAMES, "index.html"), encoding="utf-8") as f:
        html = f.read()
    pages = set(re.findall(r'<a class="ar-game" href="([a-z0-9/]+)\.html"', html))
    missing = sorted(
        p for p in pages if not os.path.exists(os.path.join(THUMBS, p + ".svg"))
    )
    assert not missing, missing
