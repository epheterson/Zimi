"""Every chess cousin offers a Hint: Xiangqi and Shogi had only Flip under the board, while Chess, Makruk and Janggi
show a good move. The hint marks the move's two squares (a drop: the square it lands on) and says it.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_cousins_hint_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401


@pytest.mark.parametrize("game", ["xiangqi", "shogi"])
def test_hint_shows_a_move(served, browser, game):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/%s.html" % (served, game))
    page.wait_for_function("() => { const b = document.getElementById('wk-hint'); return b && !b.disabled; }")
    page.locator("#wk-hint").tap()
    page.wait_for_function("() => /^Hint: /.test(document.getElementById('wk-status').textContent)", timeout=30000)
    assert page.locator("#%s .sel" % ("xq-grid" if game == "xiangqi" else "sg-board")).count() >= 1
    ctx.close()
