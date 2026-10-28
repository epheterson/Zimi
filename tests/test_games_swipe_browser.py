"""An arrow-pad game also takes a directional swipe on its playfield: one arrow per swipe, 24px, dominant axis.

Sokoban and Quest are driven with synthesized pointer events on WebKit at 390px; a short drag sends nothing, and the
page does not scroll.

Run: pytest tests/test_games_swipe_browser.py -v
"""

import functools
import http.server
import os
import threading

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import TimeoutError as PlaywrightTimeout  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")
VIEW = {"width": 390, "height": 844}
SWIPE_MS = 4000   # how long a swipe that goes nowhere (a wall) is given before the next direction is tried

SWIPE_JS = """([sel, dx, dy]) => {
  const el = document.querySelector(sel), r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const fire = (type, px, py) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: px, clientY: py, bubbles: true, button: 0, isPrimary: true }));
  fire('pointerdown', x, y); fire('pointermove', x + dx / 2, y + dy / 2); fire('pointermove', x + dx, y + dy); fire('pointerup', x + dx, y + dy);
}"""


@pytest.fixture(scope="module")
def page():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.webkit.launch()
        ctx = b.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
        pg = ctx.new_page()
        pg.base = "http://127.0.0.1:%d" % srv.server_address[1]
        yield pg
        b.close()
    srv.shutdown()


def test_sokoban_swipe(page):
    page.goto(page.base + "/sokoban.html")
    page.wait_for_function("window.__sk")
    start = page.evaluate("JSON.stringify(__sk.state())")
    page.evaluate(SWIPE_JS, ["#sk-board", 10, 0])  # under the threshold: nothing
    assert page.evaluate("JSON.stringify(__sk.state())") == start
    moved = None
    for dx, dy in ((60, 0), (0, 60), (-60, 0), (0, -60)):
        page.evaluate(SWIPE_JS, ["#sk-board", dx, dy])
        now = page.evaluate("JSON.stringify(__sk.state())")
        if now != start:
            moved = (dx, dy)
            break
    assert moved, "no swipe moved the player"
    assert page.evaluate("window.scrollY") == 0


def test_quest_swipe(page):
    page.goto(page.base + "/quest.html")
    page.wait_for_function("window.__quest")
    page.tap("#qs-screen")  # the ready tap starts it
    page.wait_for_function("__quest.mode === 'playing'")
    before = page.evaluate("[__quest.st.x, __quest.st.y]")
    for dx, dy in ((80, 0), (-80, 0), (0, 80), (0, -80)):
        page.evaluate(SWIPE_JS, ["#qs-screen", dx, dy])
        try:   # the hero steps on the game's own frame; a wall in that direction never moves it, so the wait is bounded
            page.wait_for_function("before => { const n = [__quest.st.x, __quest.st.y]; return n[0] !== before[0] || n[1] !== before[1]; }", arg=before, timeout=SWIPE_MS)
            return
        except PlaywrightTimeout:
            pass
    pytest.fail("no swipe moved the hero")
