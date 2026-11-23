"""Sideways scrollers show their bar on hover to a mouse, and never to a finger ("on Macs, the scroll bar
usually shows up when you hover over a scrollable area. Make sure that's all working").

One rule draws it everywhere (tokens.css hscroll, and its twin in the games' games.css): at 1367px with a mouse, a Home
row and a games shelf row have a real bar that takes room (macOS's own bars are overlays, shown only while scrolling, so
the bar is one of our own, a classic one), clear until the pointer is over the row and coloured then, and the row does
not change height when it shows; at 390px on a phone there is no bar at all. Chromium runs with its bars drawn
(--hide-scrollbars off), so the test measures what a person sees; SHOTS=dir keeps a picture of each row on hover.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_scrollbars_hover_live.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_home_layout_live import HOME, served  # noqa: E402,F401

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
DESK = dict(viewport={"width": 1367, "height": 900})
PHONE = dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
SHOTS = os.environ.get("SHOTS", "")
# The bar's room (the row's height less its inside), and the colour its thumb takes from the row (--hs-now: Chrome
# repaints a thumb whose colour comes from the row's own style, not one styled by row:hover::-webkit-scrollbar-thumb).
BAR = r"""(sel) => { const el = document.querySelector(sel);
  return { room: el.offsetHeight - el.clientHeight, thumb: getComputedStyle(el).getPropertyValue('--hs-now').trim(), h: el.offsetHeight }; }"""


@pytest.fixture(scope="module")
def games_site():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Quiet, directory=GAMES)
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _home(pg, served):
    pg.goto(served + "/")
    pg.wait_for_function(HOME, timeout=30000)
    pg.wait_for_selector("#discover-row .discover-scroll .discover-card", timeout=15000)
    pg.wait_for_timeout(600)   # Home draws its rows again as its late data lands
    # A small library's Discover row fits 1367px; more cards (copies of its own) make it scroll, as a real one does.
    pg.evaluate(
        "() => { const r = document.querySelector('#discover-row .discover-scroll'), c = r.querySelector('.discover-card');"
        " for (let i = 0; i < 6; i++) r.appendChild(c.cloneNode(true)); }"
    )
    return "#discover-row .discover-scroll"


def _games(pg, games_site):
    pg.add_init_script("localStorage.setItem('zimi.games.view','lobby')")
    pg.goto(games_site + "/index.html")
    pg.wait_for_selector(".ar-world .ar-game")
    return ".ar-world .ar-games"


@pytest.mark.parametrize("where", ["home", "games"])
def test_a_mouse_sees_the_bar_on_hover_a_finger_never(served, games_site, where):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(ignore_default_args=["--hide-scrollbars"])
        try:
            for opts, mouse in ((DESK, True), (PHONE, False)):
                pg = br.new_context(color_scheme="dark", **opts).new_page()
                row = _home(pg, served) if where == "home" else _games(pg, games_site)
                pg.evaluate("(s) => document.querySelector(s).scrollIntoView({ block: 'center' })", row)
                pg.mouse.move(2, 2)
                pg.wait_for_timeout(100)
                away = pg.evaluate(BAR, row)
                if not mouse:
                    assert away["room"] == 0, (where, away)
                    continue
                assert away["room"] > 0 and away["thumb"] == "transparent", (where, away)
                box = pg.locator(row).bounding_box()
                pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                pg.wait_for_timeout(100)
                over = pg.evaluate(BAR, row)
                if SHOTS:
                    clip = {"x": box["x"], "y": box["y"] - 8, "width": 700, "height": box["height"] + 16}
                    pg.screenshot(path=os.path.join(SHOTS, "bar-%s-hover.png" % where), clip=clip)
                assert over["room"] > 0 and over["thumb"] not in ("", "transparent"), (where, over)
                assert over["h"] == away["h"], "the row keeps its height when the bar shows: %s %s" % (away, over)
        finally:
            br.close()
