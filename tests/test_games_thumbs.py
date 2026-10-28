"""The shelf art and the thumbnails Zimi's Discover card loads are well-formed SVG, and everything they point at exists.

A thumbnail is a standalone file: if it `<use>`s a symbol it does not define, or leaves a tag open, it draws nothing (an empty
box on Zimi's Home). The shelf's tiles are inline in index.html and share its hidden sprite.

Run: python3 -m pytest tests/test_games_thumbs.py -q
"""

import glob
import os
import re
import xml.etree.ElementTree as ET

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")
_REF = re.compile(r"""(?:href="#|url\(#)([\w-]+)""")
_ID = re.compile(r"""\bid="([\w-]+)\"""")


def _problems(svg, shared=frozenset()):
    try:
        ET.fromstring(svg)
    except ET.ParseError as e:
        return ["not well-formed: " + str(e)]
    defined = set(_ID.findall(svg)) | set(shared)
    return ["points at #" + ref + " which nothing defines" for ref in sorted(set(_REF.findall(svg)) - defined)]


def test_every_thumbnail_is_a_complete_svg():
    bad = {}
    paths = sorted(glob.glob(os.path.join(GAMES, "thumbs", "*.svg")))
    assert paths, "no thumbnails found"
    for path in paths:
        with open(path, encoding="utf-8") as f:
            problems = _problems(f.read())
        if problems:
            bad[os.path.basename(path)] = problems
    assert not bad, bad


def test_every_shelf_tile_is_balanced_and_points_at_the_sprite():
    with open(os.path.join(GAMES, "index.html"), encoding="utf-8") as f:
        html = f.read()
    sprite = re.search(r"<!-- zimi-shelf:sprite -->(.*?)<!-- /zimi-shelf:sprite -->", html, re.S)
    shared = set(_ID.findall(sprite.group(1))) if sprite else set()
    bad = {}
    for m in re.finditer(r'<a class="ar-game" href="([a-z0-9]+)\.html">\s*(<svg class="ar-game-art".*?</svg>)\s*<span class="ar-game-text">', html, re.S):
        art = m.group(2).replace("<svg class=", '<svg xmlns="http://www.w3.org/2000/svg" class=', 1)
        problems = _problems(art, shared)
        if problems:
            bad[m.group(1)] = problems
    assert not bad, bad
    # And the pattern above really found the tiles: a broken tile that the pattern skipped would pass unseen.
    assert len(re.findall(r'<a class="ar-game" href="', html)) == len(re.findall(r'<svg class="ar-game-art"', html))
