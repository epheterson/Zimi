"""End states of the older board games on a 390 px touch phone: what the end sheet says, and what a game that comes back to its end
sheet does and says.

Run: pytest tests/test_games_pc_ends_browser.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import shell_ready  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
PHONE = {"width": 390, "height": 844}
END = ".ar-sheet.gs-end"


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass


@pytest.fixture(scope="module")
def base():
    srv = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(_Quiet, directory=GAMES)
    )
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


def _open(browser, base, page, query="debug", init=None):
    ctx = browser.new_context(viewport=PHONE, has_touch=True, is_mobile=True)
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    pg.goto("%s/%s.html?%s" % (base, page, query))
    shell_ready(pg)
    return pg


def test_mancala_last_move_into_the_store_does_not_say_play_again(browser, base):
    """A move that lands in the store gives another turn, unless it empties your side: that ends the game, and the sheet must not
    say you play again."""
    pg = _open(browser, base, "mancala")
    pg.evaluate(
        "() => { const s = __mc.state(); s.pits.set([0, 0, 0, 0, 0, 1, 30, 2, 0, 0, 0, 0, 0, 4]); s.score = [30, 4]; s.turn = 0; }"
    )
    pg.locator('.mc-pit-btn[data-i="5"]').tap()
    pg.wait_for_selector(END, timeout=15000)
    text = pg.inner_text(END)
    assert "play again" not in text.lower(), text
    assert "31 to 6" in text, text
    pg.context.close()


def test_a_game_that_comes_back_to_its_end_sheet_makes_no_vibrate_call(browser, base):
    """The browser refuses a buzz before the first tap and logs an error: a page that opens on an end sheet has had no tap."""
    stub = "window.__buzz = 0; navigator.vibrate = function () { window.__buzz++; return true; };"
    pg = _open(browser, base, "mancala", init=stub)
    pg.evaluate("() => ZimiShell.endSheet({ result: 'win', text: 'x', after: 300 })")
    pg.wait_for_selector(END, timeout=15000)
    pg.wait_for_timeout(1500)
    assert pg.evaluate("() => window.__buzz") == 0
    pg.context.close()


def test_snakes_end_sheet_keeps_its_reason_after_a_reload(browser, base):
    pg = _open(browser, base, "snakesandladders")
    pg.evaluate("() => __sl.setPositions([99, 0])")
    for _ in range(40):
        if pg.locator(END).count():
            break
        try:
            pg.locator(".sl-dieb").tap(timeout=1500)
        except Exception:
            pass
        pg.wait_for_timeout(1300)
    pg.wait_for_selector(END, timeout=5000)
    before = pg.inner_text(END)
    assert "100" in before, before
    pg.wait_for_timeout(900)
    pg.reload()
    shell_ready(pg)
    pg.wait_for_selector(END, timeout=15000)
    assert pg.inner_text(END) == before
    pg.context.close()
