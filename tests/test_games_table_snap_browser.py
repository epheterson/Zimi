"""A board game left under way keeps a picture of its table for the shelf's live tile.

Games built from page elements (squares, pieces, dice) have no canvas, so tablesnap.js paints the table as an svg: the
squares' colours, the pieces' own drawings, the words. This opens each of them, asks for the picture and checks it holds
the board (more than a bare frame, within the size the tile may keep); then plays a move in Reversi, leaves, and checks
the shelf's tile for it shows that picture in place of its art.

Run: pytest tests/test_games_table_snap_browser.py -v
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
MAX_CHARS = 90000
# page: the fewest painted shapes its opening table has (a bare frame is a handful)
BOARDS = {
    "reversi": 35,
    "checkers": 60,
    "chess": 60,
    "go": 8,
    "xiangqi": 40,
    "shogi": 40,
    "hex": 3,
    "gomoku": 10,
    "morris": 10,
    "fourinarow": 4,
    "dotsandboxes": 20,
    "backgammon": 20,
    "mancala": 10,
    "ludo": 20,
    "chinesecheckers": 40,
    "mahjong": 10,
    "fleet": 40,
    "memory": 10,
    "noughts": 9,
    "snakesandladders": 20,
    "hnefatafl": 40,
    "janggi": 40,
    "makruk": 40,
    "draughts": 40,
    "ur": 10,
    "sokoban": 20,
}


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


@pytest.fixture()
def phone(browser):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    yield ctx
    ctx.close()


def _picture(page, site, name):
    page.goto(site + name + ".html")
    page.wait_for_function("() => window.ZimiTableSnap", timeout=8000)
    page.wait_for_timeout(300)
    return page.evaluate("() => ZimiTableSnap.picture(document)")


@pytest.mark.parametrize("name", sorted(BOARDS))
def test_table_is_painted(phone, site, name):
    page = phone.new_page()
    svg = _picture(page, site, name)
    assert svg, name + " has no table picture"
    assert svg.startswith("<svg") and len(svg) <= MAX_CHARS
    shapes = (
        svg.count("<rect")
        + svg.count("<circle")
        + svg.count("<path")
        + svg.count("<text")
        + svg.count("<svg ")
    )
    assert shapes >= BOARDS[name], "%s paints %d shapes" % (name, shapes)
    assert "var(" not in svg, name + " leaves a colour unresolved"


def test_left_game_shows_its_table_on_the_shelf(phone, site):
    page = phone.new_page()
    page.goto(site + "reversi.html")
    page.wait_for_selector(".bg-sq")
    page.wait_for_function("() => window.ZimiTableSnap", timeout=8000)
    # tap squares until one is a legal move (a tap that traps nothing is refused and costs nothing)
    for i in range(64):
        page.click('.bg-sq[data-i="%d"]' % i)
        if page.evaluate("() => document.querySelectorAll('.rv-disc').length") > 4:
            break
    page.wait_for_function(
        "() => document.querySelectorAll('.rv-disc').length > 4", timeout=8000
    )
    page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
    saved = page.evaluate(
        "() => JSON.parse(localStorage.getItem('zimi.games.snaps') || '{}')['reversi.html']"
    )
    assert saved and saved["svg"].startswith("<svg")
    page.goto(site + "index.html")
    page.wait_for_selector(
        'a.ar-game[href="reversi.html"] img.ar-game-live', timeout=8000
    )
