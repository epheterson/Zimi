"""The shelf's "on the table" boxes show whole names at 390 px in every language: a name wraps to a second line before it is cut.

A playtester saw "Crucigrama ..." and "Cinco ..." on the Spanish shelf's stack of recent games (one line, cut with dots).

Run: pytest tests/test_games_shelf_table_names_browser.py -v
"""

import functools
import http.server
import json
import os
import threading
import time

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
LANGS = ["en", "es", "fr", "de", "pt", "ru"]


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


@pytest.mark.parametrize("lang", LANGS)
def test_a_name_on_the_table_wraps_before_it_is_cut(browser, site, lang):
    now = int(time.time() * 1000)
    recent = [
        {"path": "minicrossword.html", "title": "Mini Crossword", "at": now},
        {"path": "sudoku.html", "title": "Sudoku", "at": now - 1000},
        {"path": "fiveletters.html", "title": "Five Letters", "at": now - 2000},
        {"path": "minesweeper.html", "title": "Minesweeper", "at": now - 3000},
    ]
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
    )
    ctx.add_init_script(
        "try { localStorage.setItem('zimi.games.recent', %s); } catch (e) {}"
        % json.dumps(json.dumps(recent))
    )
    pg = ctx.new_page()
    pg.goto(site + "index.html#lang=" + lang)
    pg.wait_for_selector(".ar-box", timeout=15000)
    pg.wait_for_timeout(800)
    got = pg.evaluate(
        """() => [...document.querySelectorAll('.ar-box-label strong')].map((s) => ({ t: s.textContent, cut: s.scrollHeight > s.clientHeight + 1, lines: Math.round(s.clientHeight / parseFloat(getComputedStyle(s).lineHeight)) }))"""
    )
    assert len(got) >= 3, got
    assert not [g for g in got if g["cut"]], got
    assert all(g["lines"] <= 3 for g in got), got
    if os.environ.get("SHOTS") and lang == "es":
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "shelf-table-es.png"))
    ctx.close()
