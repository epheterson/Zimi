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


# Every rank that can be melded (4 to ace) laid by both sides, three or more cards each: the fullest table the rules allow.
FAKE_MELDS = """() => { const CA = ZimiCanasta, st = CA.session.state, by = {}, gone = [];
  st.stock.concat(st.hands[1], st.hands[0]).forEach(c => { const k = CA.rankKey(c); if (!CA.isWild(c) && k !== 3) (by[k] = by[k] || []).push(c); });
  const ranks = Object.keys(by).filter(k => by[k].length >= 6);
  for (let s = 0; s < 2; s++) st.melds[s] = ranks.map((k, i) => {
    const cards = by[k].splice(0, s === 0 && i % 3 === 0 && by[k].length >= 7 ? 4 : 3); gone.push(...cards); return { rank: +k, cards: cards }; });
  st.stock = st.stock.filter(c => gone.indexOf(c) < 0); st.hands = st.hands.map(h => h.filter(c => gone.indexOf(c) < 0));
  st.melded = [true, true]; return ranks.length; }"""
BOXES = """() => { const CA = ZimiCanasta, st = CA.session.state, box = id => { const r = document.querySelector('.zc-card[data-id="' + id + '"]').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const melds = [].concat(st.melds[0], st.melds[1]).map(m => m.cards.map(box));
  return { melds: melds, stock: box(st.stock[st.stock.length - 1]), pile: box(st.pile[st.pile.length - 1]), hand: st.hands[0].map(box),
    ui: [].map.call(document.querySelectorAll('.cn-btn, .ct-chip'), e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }),
    w: innerWidth, h: innerHeight }; }"""


def _overlap(a, b):
    return min(a[2], b[2]) - max(a[0], b[0]) > 1 and min(a[3], b[3]) - max(a[1], b[1]) > 1


def test_eleven_melds_a_side_overlap_nothing(served, browser):
    for w, h in ((390, 844), (375, 667), (560, 800), (600, 900), (640, 1000), (640, 700), (560, 375), (600, 400), (640, 360), (1280, 800)):
        ctx = browser.new_context(viewport={"width": w, "height": h}, has_touch=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.add_init_script(path=os.path.join(GAMES, "util.js"))
        page.add_init_script(SEEDED % 1)
        page.goto("%s/canasta.html" % served)
        page.wait_for_function("window.ZimiCanasta && ZimiCanasta.session && ZimiCanasta.session.state")
        assert page.evaluate(FAKE_MELDS) == 11
        page.set_viewport_size({"width": w, "height": h - 1})   # a resize repaints from the faked state
        page.wait_for_timeout(300)
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(900)
        b = page.evaluate(BOXES)
        where = "%dx%d" % (w, h)
        flat = [(i, c) for i, m in enumerate(b["melds"]) for c in m]
        for i, c in flat:
            assert c[0] >= -1 and c[1] >= -1 and c[2] <= b["w"] + 1 and c[3] <= b["h"] + 1, "%s: meld card off screen %s" % (where, c)
            for other in [b["stock"], b["pile"]] + b["hand"] + b["ui"]:
                assert not _overlap(c, other), "%s: meld card %s runs into %s" % (where, c, other)
        for i, c in flat:
            for j, d in flat:
                assert i >= j or not _overlap(c, d), "%s: melds %d and %d overlap: %s %s" % (where, i, j, c, d)
        assert not errors, errors
        ctx.close()
