"""On a phone a solitaire column is one card wide (Spider: 35 px), so the table under a column answers for it.

A tap in the empty table under a column is a tap on its top card: it moves the card, or the card shakes to say no.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_reach_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401
from games_wait import game_ready, quiet  # noqa: E402

# Watch the top card of a pile for the answer to a tap: the session's move count changes, or the card shakes.
WATCH = """(pile) => {
  const s = ZimiSpider.session.state, ids = s.piles[pile], top = ids[ids.length - 1];
  const el = document.querySelector('.zc-card[data-id="' + top.id + '"]');
  window.__heard = false; window.__moves = s.moves;
  new MutationObserver(() => { if (/gs-shake|gs-flash|zc-hint/.test(el.className)) window.__heard = true; }).observe(el, { attributes: true });
  const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.bottom];
}"""
HEARD = "() => window.__heard || ZimiSpider.session.state.moves !== window.__moves"


def test_a_tap_under_a_column_reaches_its_top_card(served, browser):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/spider.html" % served)
    page.wait_for_selector(".zc-card", state="attached")
    page.wait_for_function("() => window.ZimiSpider && ZimiSpider.session && ZimiSpider.session.state.piles.c0.length > 0")
    game_ready(page)   # the deal lands
    quiet(page, 1500)
    x, bottom = page.evaluate(WATCH, "c3")
    page.touchscreen.tap(x, bottom + 200)
    quiet(page, 400)
    assert page.evaluate(HEARD), "a tap under column 4 went nowhere"
    ctx.close()

