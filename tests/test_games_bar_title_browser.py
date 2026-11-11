"""A game's name in Zimi's bar on a phone: the longest game name in each of the ten languages either shows whole, or ends in an
ellipsis with the full name as its tooltip; the bar's buttons stay on screen, 40px wide at least, and never overlap the name.
Polyominoes (the English name that was cut to "Polyomin...") shows whole.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_bar_title_browser.py -v
"""

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_games_home_isolation import browser, zimi  # noqa: E402,F401

TEXT = os.path.join(os.path.dirname(HERE), "zimi", "builtin", "games", "text")
LANGS = ["ar", "de", "en", "es", "fr", "he", "hi", "pt", "ru", "zh"]
WIDTHS = [360, 390]
PER_LANG = 3
WIDE_SCRIPT = 1.8  # a Chinese character is about this many Latin letters wide


def longest(lang):
    with open(os.path.join(TEXT, lang + ".json"), encoding="utf-8") as f:
        table = json.load(f)
    names = {
        v
        for k, v in table.items()
        if k.startswith("game.") and k.endswith(".title") and isinstance(v, str)
    }
    weight = WIDE_SCRIPT if lang == "zh" else 1
    return sorted(names, key=lambda n: -len(n) * weight)[:PER_LANG]


NAMES = [(lang, n) for lang in LANGS for n in longest(lang)] + [("en", "Polyominoes")]

FIT = """([name, dir]) => {
  document.documentElement.dir = dir;
  document.body.classList.add('game-page');
  const head = document.getElementById('game-head'), title = document.getElementById('game-title');
  head.hidden = false;
  for (const id of ['game-act-btn', 'game-menu-btn']) { const b = document.getElementById(id); b.hidden = false; }
  document.getElementById('game-act-btn').innerHTML = _GAME_ACT_SVG.undo;
  title.textContent = name;
  _fitGameTitle(title);
  const t = title.getBoundingClientRect(), bar = document.querySelector('.topbar').getBoundingClientRect();
  const btns = [...head.querySelectorAll('.reader-btn')].map(b => b.getBoundingClientRect());
  return { whole: !_titleOverflows(title), tip: title.title, ellipsis: getComputedStyle(title).textOverflow, barOver: document.querySelector('.topbar').scrollWidth > document.querySelector('.topbar').clientWidth,
           btnW: Math.min(...btns.map(b => b.width)), btnsIn: btns.every(b => b.left >= bar.left - 0.5 && b.right <= bar.right + 0.5),
           overlap: btns.some(b => b.left < t.right - 0.5 && b.right > t.left + 0.5), px: parseFloat(getComputedStyle(title).fontSize) };
}"""


@pytest.mark.parametrize("width", WIDTHS)
@pytest.mark.parametrize("lang,name", NAMES, ids=lambda v: str(v))
def test_the_name_fits_or_ends_in_an_ellipsis(zimi, browser, width, lang, name):
    ctx = browser.new_context(
        viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True
    )
    page = ctx.new_page()
    page.goto(zimi)
    page.wait_for_function(
        "() => typeof _fitGameTitle === 'function' && typeof _GAME_ACT_SVG === 'object'"
    )
    got = page.evaluate(FIT, [name, "rtl" if lang in ("ar", "he") else "ltr"])
    assert not got["barOver"] and got["btnsIn"] and not got["overlap"], (name, got)
    assert got["btnW"] >= 40, (name, got)
    assert got["whole"] or (got["ellipsis"] == "ellipsis" and got["tip"] == name), (
        name,
        got,
    )
    if name == "Polyominoes":
        assert got["whole"], got
    ctx.close()
