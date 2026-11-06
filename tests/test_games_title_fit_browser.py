"""A long game name fits the bar on a phone: "International Draughts" beside Undo and Menu steps its size down instead of
being cut to "International Drau...".

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_title_fit_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import browser, served  # noqa: E402,F401


@pytest.mark.parametrize("width", [360, 390])
def test_the_whole_name_shows(served, browser, width):
    ctx = browser.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/draughts.html" % served)
    page.wait_for_function("() => document.documentElement.classList.contains('gs-ready')")
    page.wait_for_timeout(300)
    assert page.evaluate("() => { const h = document.querySelector('.ar-bar h1'); return h.scrollWidth <= h.clientWidth; }")
    ctx.close()
