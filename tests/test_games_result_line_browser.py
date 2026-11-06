"""The line under a won board game reads "You won! Checkmate.", not "You won!. Checkmate.".

WorldKit joined the result and the reason with a full stop, after a result that already ends in "!".

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_result_line_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

MATE_IN_ONE = "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"


def test_a_win_reads_once_punctuated(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/chess.html?debug" % served)
    page.wait_for_function("() => window.__cs")
    page.evaluate("(f) => __cs.setFen(f)", MATE_IN_ONE)
    page.evaluate("() => __cs.play(__cs.engine.legalMoves(__cs.pos()).find(m => __cs.engine.squareName(__cs.engine.to(m)) === 'd8'))")
    page.wait_for_function("() => /won/i.test(document.getElementById('wk-msg') ? document.getElementById('wk-msg').textContent : document.body.innerText)")
    text = page.evaluate("() => (document.getElementById('wk-msg') || document.body).innerText")
    assert "!." not in text and "You won! Checkmate" in text, text
    ctx.close()
