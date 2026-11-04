"""Inside Zimi on a phone, a game's whole name shows in the header: "Dictionary Bluff" steps its size down, and
"Snakes and Ladders" takes two lines, where both were cut to "Dictionary Bl..." and "Snakes and La...".

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_head_title_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_final_fixes import _open, browser, zimi  # noqa: E402,F401

FITS = """() => { const e = document.getElementById('game-title');
  return [e.textContent, e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1]; }"""


@pytest.mark.parametrize("page_name", ["bluff.html", "higherlower.html", "snakesandladders.html", "whereintheworld.html"])
def test_the_whole_name_shows(zimi, browser, page_name):
    ctx, page, errors = _open(browser, zimi, page_name, scheme="light")
    page.wait_for_function("() => document.body.classList.contains('game-page') && document.getElementById('game-title').textContent.length > 3")
    name, fits = page.evaluate(FITS)
    assert fits, name
    ctx.close()
