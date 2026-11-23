"""A finished game that is taken up again (a reload) is not won a second time in the record.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_finished_reload_browser.py -v
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
PHONE = {"width": 390, "height": 844}


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


@pytest.fixture
def phone(browser):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.errors = errors
    yield page
    ctx.close()


def open_game(page, site, name, wait_for, minimum_cards=1):
    page.goto(site + name + ".html")
    page.wait_for_function(wait_for, timeout=8000)
    page.wait_for_function(
        "(n) => document.querySelectorAll('.zc-card[data-id]').length >= n",
        arg=minimum_cards,
        timeout=8000,
    )
    page.wait_for_timeout(2500)  # the deal's cards fly in


def card_point(page, card_id):
    return page.evaluate(
        """(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: b.x + Math.min(10, b.width / 3), y: b.y + b.height * 0.25 }; }""",
        card_id,
    )


def tap_card(page, card_id):
    p = card_point(page, card_id)
    for _ in range(20):
        assert p, "card %s is not on the table" % card_id
        page.wait_for_timeout(120)
        q = card_point(page, card_id)
        if q == p:
            break
        p = q
    page.touchscreen.tap(p["x"], p["y"])



# ── a finished game taken up again is not won twice ──────────────────────────

# One card left in your hand, the rank to say: play it, and when the others let it go you are out.
CHEAT_END = {
    "players": 3,
    "hands": [[6], [0, 14, 28, 40, 41], [1, 2, 15, 16, 17]],
    "pile": [3, 4, 5],
    "claim": 7,
    "turn": 0,
    "phase": "play",
    "callers": [],
    "last": None,
    "tells": [{"called": 0, "lied": 0}] * 3,
    "turns": 6,
    "winner": -1,
    "moves": 6,
}


def test_a_won_game_that_is_reloaded_is_counted_once(browser, site):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    save = json.dumps({"v": 1, "at": int(time.time() * 1000), "data": {"id": "cheat", "state": CHEAT_END, "history": [], "ms": 4000, "ending": None}})
    # Planted only while the page has no record of its own, so the reload below keeps what the game wrote.
    ctx.add_init_script(
        "try { if (!localStorage.getItem('zimi.games.save.cheat')) localStorage.setItem('zimi.games.save.cheat', %s); } catch (e) {}"
        % json.dumps(save)
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(site + "cheat.html")
    page.wait_for_selector(".zc-card", state="attached", timeout=10000)
    tap_card(page, 6)
    page.locator(".ct-choice.ct-primary").first.tap()
    for _ in range(60):
        st = page.evaluate("() => window.ZimiCheat.session.state")
        if st["phase"] == "over":
            break
        if st["phase"] == "call" and st["callers"][0] == 0:
            page.locator(".ct-choice", has_text="Let it go").first.tap()
        page.wait_for_timeout(300)
    page.wait_for_function("() => document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')", timeout=10000)
    record = "() => JSON.parse(localStorage.getItem('zimi.games.stats.cheat'))"
    first = page.evaluate(record)
    assert first["won"] == 1
    page.wait_for_timeout(1000)  # the game keeps its finished state
    page.reload()
    page.wait_for_selector(".zc-card", state="attached", timeout=10000)
    page.wait_for_timeout(1500)
    page.reload()
    page.wait_for_selector(".zc-card", state="attached", timeout=10000)
    page.wait_for_timeout(1500)
    assert page.evaluate(record)["won"] == 1, "a reload counted the win again"
    assert page.evaluate("() => !!document.querySelector('.gs-sheet, .ar-sheet, .zc-sheet, .gs-end')"), "the finished game's sheet did not come back"
    assert not errors
    ctx.close()
