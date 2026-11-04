"""Canasta in a browser: the first meld has to reach its minimum in one go, and the screen says so before the card is laid.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_canasta_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

GAMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "zimi", "builtin", "games")
SEEDED = """
(() => { let rng = null; Math.random = function () { if (!rng) rng = window.ZimiUtil.mulberry32(%d); return rng(); }; })();
"""
# After drawing: the naturals of three or more of a rank the hand holds, as lists of ids (never wild cards, threes or red cards).
GROUPS = """() => {
  const CA = ZimiCanasta, st = CA.session.state, by = {};
  st.hands[0].forEach(c => { if (!CA.isWild(c) && CA.rankKey(c) !== 3) (by[CA.rankKey(c)] = by[CA.rankKey(c)] || []).push(c); });
  return Object.values(by).filter(g => g.length >= 3).map(g => ({ ids: g, pts: CA.sumPts(g) }));
}"""


def tap_card(page, card):
    """A tap on the visible strip of a hand card (the cards overlap)."""
    pt = page.evaluate("""(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'), r = e.getBoundingClientRect();
      for (let y = r.top + 2; y < r.bottom; y += 3) for (let x = r.left + 2; x < r.right; x += 3) { const h = document.elementFromPoint(x, y), c = h && h.closest && h.closest('.zc-card'); if (c && c.dataset.id === String(id)) return [x, y]; }
      return null; }""", card)
    assert pt, "card %s is covered" % card
    page.mouse.click(pt[0], pt[1])
    page.wait_for_timeout(60)


def deal_with_a_weak_and_a_strong_group(browser, served):
    """A seeded deal, after the draw, where one group of three is under 50 points and the groups together reach it."""
    for seed in range(1, 80):
        ctx = browser.new_context(viewport=VIEW, has_touch=True)
        page = ctx.new_page()
        page.add_init_script(path=os.path.join(GAMES, "util.js"))
        page.add_init_script(SEEDED % seed)
        page.goto("%s/canasta.html" % served)
        page.wait_for_function("window.ZimiCanasta && ZimiCanasta.session && ZimiCanasta.session.state")
        page.locator(".cn-btn").nth(0).click()   # Draw 2
        page.wait_for_function("ZimiCanasta.session.state.step === 'play'")
        page.wait_for_timeout(900)   # the two cards finish flying into the hand
        groups = page.evaluate(GROUPS)
        weak = [g for g in groups if g["pts"] < 50]
        if weak and len(groups) >= 2 and sum(g["pts"] for g in groups) >= 50:
            return ctx, page, weak[0], [g for g in groups if g is not weak[0]]
        ctx.close()
    raise AssertionError("no seed gave a deal with a weak and a strong group")


def test_a_first_meld_below_the_minimum_cannot_be_laid(served, browser):
    ctx, page, weak, rest = deal_with_a_weak_and_a_strong_group(browser, served)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    meld = page.locator(".cn-btn").nth(0)
    for card in weak["ids"][:3]:
        tap_card(page, card)
    assert meld.is_disabled(), "a group worth %d must not be layable as the first meld of 50" % weak["pts"]
    assert "first meld needs 50" in page.locator("#zc-table").inner_text()
    # every group at once reaches the minimum, and lays
    for group in rest:
        for card in group["ids"]:
            tap_card(page, card)
    assert meld.is_enabled()
    meld.click()
    page.wait_for_function("ZimiCanasta.session.state.melds[0].length >= 2")
    page.wait_for_timeout(900)
    # a meld is its cards, fanned overlapping, not one card and a count
    for ids in page.evaluate("ZimiCanasta.session.state.melds[0].map(m => m.cards)"):
        xs = page.evaluate("(ids) => ids.map(id => document.querySelector('.zc-card[data-id=\"' + id + '\"]').getBoundingClientRect().left)", ids)
        assert len(set(round(x) for x in xs)) == len(ids), "a meld of %d cards should be fanned, got %s" % (len(ids), xs)
    assert not errors
    ctx.close()
