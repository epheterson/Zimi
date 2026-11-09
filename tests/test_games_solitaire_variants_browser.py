"""The solitaire variants on a 390 px touch phone: each opens without a page error, lays out inside the width, answers a tap, and is
won from its one-move-from-a-win fixture (?debug=win) with the end sheet up.

Run: pytest tests/test_games_solitaire_variants_browser.py -v
"""

import functools
import http.server
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
VARIANTS = [
    ("yukon", "ZimiYukon"),
    ("fortythieves", "ZimiFortyThieves"),
    ("canfield", "ZimiCanfield"),
    ("scorpion", "ZimiScorpion"),
    ("acesup", "ZimiAcesUp"),
    ("accordion", "ZimiAccordion"),
    ("calculation", "ZimiCalculation"),
    ("beleaguered", "ZimiBeleaguered"),
    ("eightoff", "ZimiEightOff"),
    ("montecarlo", "ZimiMonteCarlo"),
]
END = "document.querySelector('.ar-sheet:not([hidden]) .gs-primary') && window['%s'].session.won"
# A card to tap that the game itself would send somewhere: the first one with a move (the stock turns, if nothing else does).
FIND_TAP = """(g) => {
  const api = window[g], st = api.session.state;
  for (const from of Object.keys(st.piles)) for (let idx = st.piles[from].length - 1; idx >= 0; idx--) {
    if (!api.canPick(st, from, idx) || !api.bestMove(st, from, idx)) continue;
    const c = st.piles[from][idx], id = typeof c === 'number' ? c : c.id, e = document.querySelector('.zc-card[data-id="' + id + '"]');
    if (!e) continue;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.2, moves: st.moves, from, idx };
  }
  return null;
}"""
# The card whose tap makes the last move: the fixture's only way to win, as the game's own bestMove sends it.
FIND_WIN = """(g) => {
  const api = window[g], st = api.almostWon();
  for (const from of Object.keys(st.piles)) for (let idx = 0; idx < st.piles[from].length; idx++) {
    const to = api.canPick(st, from, idx) && api.bestMove(st, from, idx);
    if (!to || !api.isWon(api.applyMove(st, from, idx, to))) continue;
    const c = api.session.state.piles[from][idx], e = document.querySelector('.zc-card[data-id="' + c.id + '"]');
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.2 };
  }
  return null;
}"""


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


def _open(browser, site, page, query="", scheme="light"):
    ctx = browser.new_context(
        viewport=PHONE,
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        color_scheme=scheme,
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(site + page + ".html" + query)
    pg.wait_for_selector(".zc-card", state="attached", timeout=15000)
    pg.wait_for_function("() => !document.querySelector('.zc-dealing')", timeout=15000)
    pg.wait_for_timeout(300)
    return pg


@pytest.mark.parametrize("page,game", VARIANTS)
@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_opens_inside_the_phone_with_no_errors(browser, site, page, game, scheme):
    pg = _open(browser, site, page, scheme=scheme)
    assert not pg.errors, pg.errors
    wide = pg.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    assert wide <= 0, "the page is %s px wider than the phone" % wide
    out = pg.evaluate(
        """() => [...document.querySelectorAll('.zc-card:not(.zc-off)')].filter((c) => {
          const r = c.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > window.innerWidth + 1);
        }).length"""
    )
    assert out == 0, "%d cards run off the side" % out
    assert pg.inner_text("h1").strip(), "the bar names the game"
    pg.context.close()


@pytest.mark.parametrize("page,game", VARIANTS)
def test_a_tap_moves_a_card_and_undo_takes_it_back(browser, site, page, game):
    pg = _open(browser, site, page)
    at = pg.evaluate(FIND_TAP, game)
    if (
        at is None
    ):  # no card has a place to go from the first deal: the stock is the move
        pg.evaluate(
            "(g) => window[g].session.reset(window[g].newState(window.ZimiSolKit.shuffledDecks(g === 'ZimiFortyThieves' ? 2 : 1, () => 0.25)))",
            game,
        )
        at = pg.evaluate(FIND_TAP, game)
    if at is not None:
        before = pg.evaluate(
            "(g) => JSON.stringify(window[g].session.state.piles)", game
        )
        pg.touchscreen.tap(at["x"], at["y"])
        pg.wait_for_timeout(500)
        after = pg.evaluate(
            "(g) => JSON.stringify(window[g].session.state.piles)", game
        )
        assert after != before, "a tap on a card with a move changed nothing"
        pg.click("#zc-undo")
        pg.wait_for_timeout(300)
        assert (
            pg.evaluate("(g) => JSON.stringify(window[g].session.state.piles)", game)
            == before
        ), "Undo did not take the move back"
    assert not pg.errors, pg.errors
    pg.context.close()


@pytest.mark.parametrize("page,game", VARIANTS)
def test_won_from_one_move_away_with_the_end_sheet(browser, site, page, game):
    pg = _open(browser, site, page, "?debug=win")
    at = pg.evaluate(FIND_WIN, game)
    assert at is not None, "the fixture has no card whose tap wins"
    pg.touchscreen.tap(at["x"], at["y"])
    pg.wait_for_function(END % game, timeout=15000)
    assert pg.evaluate("(g) => window[g].isWon(window[g].session.state)", game)
    assert not pg.errors, pg.errors
    pg.context.close()


@pytest.mark.parametrize("page,game", VARIANTS)
def test_a_game_left_comes_back_as_it_was(browser, site, page, game):
    pg = _open(browser, site, page)
    at = pg.evaluate(FIND_TAP, game)
    if at is not None:
        pg.touchscreen.tap(at["x"], at["y"])
        pg.wait_for_timeout(500)
    kept = pg.evaluate("(g) => JSON.stringify(window[g].session.state)", game)
    if at is None or not pg.evaluate("(g) => window[g].session.state.moves", game):
        pg.context.close()
        pytest.skip("no move was made, so nothing is kept")
    pg.reload()
    pg.wait_for_selector(".zc-card", state="attached", timeout=15000)
    pg.wait_for_timeout(600)
    assert pg.evaluate("(g) => JSON.stringify(window[g].session.state)", game) == kept, "the position did not come back"
    assert not pg.errors, pg.errors
    pg.context.close()
