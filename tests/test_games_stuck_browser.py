"""Klondike and Spider say when no move is left, with the sheet FreeCell already had (Undo, New game).

A position one move from stuck is kept as the game's save, and the move is made by a tap: the sheet comes up. A position
with a move left shows nothing.

Run: pytest tests/test_games_stuck_browser.py -v
"""

import functools
import http.server
import json
import os
import threading

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
PHONE = {"width": 390, "height": 844}
CLUBS, DIAMONDS, HEARTS, SPADES = 0, 1, 2, 3


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


# The game's own blank state, with these piles of (rank, suit) cards, all face up, as the game's save. The page writes its own
# save as it unloads, so the save goes in before the page's scripts run (an init script), not into a page about to reload.
BUILD = """([game, key, suits, piles]) => {
  const Z = window.ZimiCards, G = window[game], st = G.blankState(suits);
  Object.keys(piles).forEach((p) => { st.piles[p] = piles[p].map((c) => ({ id: Z.make(c[0], c[1]), up: true })); });
  return JSON.stringify({ v: 1, at: Date.now(), data: { id: key, state: st, history: [], ms: 5000, ending: null } });
}"""
TAP = """([rank, suit]) => {
  const id = window.ZimiCards.make(rank, suit), b = document.querySelector('.zc-card[data-id="' + id + '"]').getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height * 0.2 };
}"""


def _open(browser, site, page_name, game, key, suits, piles):
    probe = browser.new_page()
    probe.goto(site + page_name)
    probe.wait_for_function("(g) => window[g] && window.ZimiCards", arg=game)
    save = probe.evaluate(BUILD, [game, key, suits, piles])
    probe.close()
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.save.%s', %s); } catch (e) {}" % (key, json.dumps(save))
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(site + page_name)
    pg.wait_for_selector(".zc-card", state="attached", timeout=15000)
    pg.wait_for_timeout(500)
    return pg


def _tap(pg, rank, suit):
    at = pg.evaluate(TAP, [rank, suit])
    pg.touchscreen.tap(at["x"], at["y"])


def test_klondike_says_it_is_stuck_after_the_last_move(browser, site):
    pg = _open(
        browser,
        site,
        "solitaire.html",
        "ZimiSolitaire",
        "solitaire",
        1,
        {"t0": [(9, CLUBS)], "t1": [(8, HEARTS)], "t2": [(6, DIAMONDS)]},
    )
    assert "No moves left" not in pg.inner_text("body")
    _tap(pg, 8, HEARTS)  # the eight goes on the nine of clubs: then nothing is left
    pg.wait_for_function(
        "() => /No moves left/.test(document.body.innerText)", timeout=5000
    )
    text = pg.inner_text("body")
    assert "Undo a few moves" in text, text
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "klondike-stuck.png"))
    assert not pg.errors, pg.errors


def test_klondike_with_a_move_left_shows_no_sheet(browser, site):
    pg = _open(
        browser,
        site,
        "solitaire.html",
        "ZimiSolitaire",
        "solitaire",
        1,
        {"t0": [(9, CLUBS)], "t1": [(8, HEARTS)], "t2": [(7, CLUBS)]},
    )
    _tap(pg, 8, HEARTS)  # the seven of clubs can still go on the eight
    pg.wait_for_timeout(800)
    assert "No moves left" not in pg.inner_text("body")


def test_spider_says_it_is_stuck_when_no_run_goes_and_no_deal_is_left(browser, site):
    # Every top card is far from the one above it, so the five of spades onto the six is the last move: no column takes anything
    # after it, nothing is empty, and the stock is out.
    piles = {
        "c0": [(6, SPADES)], "c1": [(13, SPADES), (5, SPADES)], "c2": [(2, SPADES)], "c3": [(10, SPADES)], "c4": [(8, SPADES)],
        "c5": [(13, HEARTS)], "c6": [(2, HEARTS)], "c7": [(8, HEARTS)], "c8": [(10, HEARTS)], "c9": [(5, HEARTS)],
    }
    pg = _open(browser, site, "spider.html", "ZimiSpider", "spider", 1, piles)
    assert "No moves left" not in pg.inner_text("body")
    _tap(pg, 5, SPADES)
    pg.wait_for_function("() => /No moves left/.test(document.body.innerText)", timeout=5000)
    assert "Undo a few moves" in pg.inner_text("body")
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "spider-stuck.png"))
    assert not pg.errors, pg.errors
