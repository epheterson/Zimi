"""Every game page passes an axe-core sweep, on a phone and on a desktop, light and dark, left to right and right to left.

axe-core is vendored (tests/vendor/axe.min.js, MPL-2.0), so the sweep runs offline. Each page in games.json (and the shelf) is
opened, given a moment to build, tapped once in the middle (a game's first screen is often a start banner), and checked.
The default run covers every page at 390 wide in light, plus every page at the other widths, themes and the two right-to-left
languages for a spread of games; ZIMI_AXE_FULL=1 runs the whole matrix for every page.

Run: pytest tests/test_games_axe.py -v        (ZIMI_AXE_FULL=1 for everything, ZIMI_AXE_REPORT=<file> to write every violation)
"""

import json
import os
import sys

import pytest

pytest.importorskip("playwright")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_trick_fixtures import GAMES, browser, served  # noqa: E402,F401
from games_wait import quiet  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
AXE = open(os.path.join(HERE, "vendor", "axe.min.js"), encoding="utf-8").read()
PAGES = ["index.html"] + sorted({g["path"] for g in json.load(open(os.path.join(GAMES, "games.json"), encoding="utf-8")) if g.get("path")})
FULL = os.environ.get("ZIMI_AXE_FULL") == "1"
REPORT = os.environ.get("ZIMI_AXE_REPORT")

WIDTHS = (320, 390, 1280)
THEMES = ("light", "dark")
LANGS = ("en", "he", "ar")
# One game of each family carries the whole matrix in the default run: cards, boards, puzzles, arcade, word, the shelf.
SPREAD = ("index.html", "solitaire.html", "chess.html", "codebreaker.html", "snake.html", "five.html", "minesweeper.html", "sudoku.html")

# A game page is one application, not a document: landmarks, a main region, an h1 and skip links do not apply.
RULES_OFF = ["region", "landmark-one-main", "page-has-heading-one", "bypass"]

RUN = """
async () => {
  const r = await axe.run(document, { rules: %s, resultTypes: ['violations'] });
  return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map(n => ({ t: n.target.join(' '), s: (n.failureSummary || '').split('\\n').slice(1, 3).join(' ') })), count: v.nodes.length }));
}
""" % json.dumps({r: {"enabled": False} for r in RULES_OFF})


def cases():
    out = []
    for path in PAGES:
        out.append((path, 390, "light", "en"))
        if FULL or path in SPREAD:
            for w in WIDTHS:
                for t in THEMES:
                    for lang in (LANGS if (FULL or w == 390) else ("en",)):
                        c = (path, w, t, lang)
                        if c not in out:
                            out.append(c)
    return out


def scan(browser, served, path, width, theme, lang):
    ctx = browser.new_context(viewport={"width": width, "height": 844 if width < 800 else 800}, color_scheme=theme, has_touch=width < 800, is_mobile=width < 800)
    page = ctx.new_page()
    try:
        page.goto("%s/%s#lang=%s" % (served, path, lang))
        page.wait_for_load_state("load")
        quiet(page, 1200)   # built: nothing changing, nothing animating (at most the 1.2 s this once waited)
        page.mouse.click(width // 2, 420)
        quiet(page, 500)
        page.add_script_tag(content=AXE)
        return page.evaluate(RUN)
    finally:
        ctx.close()


@pytest.mark.parametrize("path,width,theme,lang", cases(), ids=lambda v: str(v))
def test_axe_finds_nothing(browser, served, path, width, theme, lang):
    found = scan(browser, served, path, width, theme, lang)
    if REPORT:
        with open(REPORT, "a", encoding="utf-8") as f:
            f.write(json.dumps({"case": [path, width, theme, lang], "violations": found}) + "\n")
    assert not found, "%s at %d %s %s: %s" % (path, width, theme, lang, json.dumps(found, ensure_ascii=False)[:1800])
