"""Corners, slots, sheets and chips: the small geometry that has to be exact.

A card's index stands clear of its pips; a foundation's place is the card's size to the pixel; every game's sheet shares one
row of actions (the quiet one left, the primary wide); the shelf's chip row scrolls sideways only; Game of the day shows in both views.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_catalog_polish.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

DESKTOP = {"width": 1100, "height": 800}
PIP_CLEAR_UNITS = 7   # of the face's 100-unit width, between the corner suit and the pip beside it


@pytest.fixture(params=[VIEW, DESKTOP], ids=["phone", "desktop"])
def page(browser, request):
    ctx = browser.new_context(viewport=request.param)
    yield ctx.new_page()
    ctx.close()


def open_solitaire(page, served):
    page.goto("%s/solitaire.html" % served)
    page.wait_for_selector(".zc-card:not(.zc-off)")
    page.wait_for_timeout(300)


def test_a_foundation_place_is_exactly_a_card(page, served):
    open_solitaire(page, served)
    box = page.evaluate("""() => {
      const card = document.querySelector('.zc-card:not(.zc-off)').getBoundingClientRect();
      return [...document.querySelectorAll('.zc-slot[data-goal]')].map(s => {
        const b = getComputedStyle(s, '::before');
        return { w: parseFloat(b.width), h: parseFloat(b.height), cw: card.width, ch: card.height, sizing: b.boxSizing };
      });
    }""")
    assert len(box) == 4
    for b in box:
        assert b["sizing"] == "border-box"
        assert abs(b["w"] - b["cw"]) < 0.01 and abs(b["h"] - b["ch"]) < 0.01, b


def test_the_stock_and_waste_have_air(page, served):
    open_solitaire(page, served)
    r = page.evaluate("""() => {
      const q = p => document.querySelector('[data-pile=' + p + ']').getBoundingClientRect();
      const card = document.querySelector('.zc-card:not(.zc-off)').getBoundingClientRect();
      const t0 = q('t0'), stock = q('stock'), waste = q('waste');
      return { below: t0.top - (stock.top + card.height), between: waste.left - (stock.left + card.width), cw: card.width };
    }""")
    assert r["below"] >= r["cw"] * 0.25, r   # the columns start a quarter of a card's height-share under the top row
    assert r["between"] >= r["cw"] * 0.1, r


def test_the_new_game_sheet_has_one_row_of_actions(page, served):
    open_solitaire(page, served)
    page.get_by_role("button", name="Menu").first.click()
    page.locator(".gs-newgame").click()
    cancel = page.locator(".gs-actions button", has_text="Cancel").bounding_box()
    start = page.locator(".gs-actions button", has_text="Start").bounding_box()
    assert abs(cancel["y"] - start["y"]) < 1 and abs(cancel["height"] - start["height"]) < 1   # one row
    assert cancel["x"] < start["x"] and start["width"] > cancel["width"]   # the quiet one first, the primary wide


def test_a_card_index_stands_clear_of_its_pips(page, served):
    open_solitaire(page, served)
    worst = page.evaluate("""(clear) => {
      const Z = window.ZimiCards, host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;z-index:99;display:flex;flex-wrap:wrap;gap:8px;width:900px';
      document.body.appendChild(host);
      let worst = 1e9;
      for (let s = 0; s < 4; s++) for (let r = 2; r <= 10; r++) {
        const id = Z.make(r, s), d = document.createElement('div');
        d.className = 'zc-card'; d.style.cssText = 'position:relative;--cw:100px;width:100px;height:140px';
        d.innerHTML = '<div class="zc-face">' + Z.faceMarkup(id) + '</div>'; host.appendChild(d);
        const suit = d.querySelector('.zc-idx-std').children[1].getBoundingClientRect(), box = d.getBoundingClientRect();
        d.querySelectorAll('.zc-big > g').forEach(p => {
          const b = p.getBoundingClientRect();
          if (b.bottom > suit.top && b.top < suit.bottom && b.left > suit.right) worst = Math.min(worst, (b.left - suit.right) / box.width * 100);
        });
      }
      host.remove();
      return worst;
    }""", PIP_CLEAR_UNITS)
    assert worst >= PIP_CLEAR_UNITS, worst


@pytest.mark.parametrize("view", ["lobby", "index"])
def test_the_chip_row_scrolls_sideways_only(browser, served, view):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.add_init_script("try{localStorage.setItem('zimi.games.view','%s')}catch(e){}" % view)
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".sh-nav .sh-chip")
    nav = page.evaluate("""() => { const n = document.querySelector('.sh-nav'), c = getComputedStyle(n);
      return { y: c.overflowY, x: c.overflowX, touch: c.touchAction, sh: n.scrollHeight, ch: n.clientHeight }; }""")
    assert nav["y"] == "hidden" and nav["x"] in ("auto", "scroll") and nav["touch"] == "pan-x", nav
    assert nav["sh"] <= nav["ch"], nav   # nothing to scroll vertically
    chip = page.evaluate("""() => { const c = getComputedStyle(document.querySelector('.sh-chip')); return { h: c.height, r: c.borderRadius, fs: c.fontSize }; }""")
    assert chip["h"] == "28px" and chip["fs"] == "12px", chip   # the Library Manager's pill
    ctx.close()


def test_game_of_the_day_shows_in_the_compact_view_in_every_section(browser, served):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.add_init_script("try{localStorage.setItem('zimi.games.view','index')}catch(e){}")
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-today .ar-game", state="attached")
    for chip in (0, 1, 2):
        page.locator(".sh-nav .sh-chip:visible").nth(chip).click()
        page.wait_for_timeout(150)
        assert page.locator(".ar-today").is_visible(), chip
    ctx.close()
