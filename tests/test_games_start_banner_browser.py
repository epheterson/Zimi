"""The "This game failed to start" banner is for a game that drew nothing, never for a working table.

Eric saw it over a Truco hand he was playing: a stray error while the page started (a ResizeObserver note, a late
listener) raised the alarm over a game that had started fine. The banner now waits out the start and appears only
when the page has nothing of the game on screen; a script that would not load still raises it at once.

Run: pytest tests/test_games_start_banner_browser.py -v
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
GRACE_WAIT_MS = (
    6000  # the shell's start grace (2.5 s) after load, then its own grace, with room
)

THROWS_BUT_PLAYS = "setTimeout(function () { throw new Error('a late corner'); }, 300);"
BLANK = (
    '<!doctype html><html><head><meta charset="utf-8"><title>Blank</title><script src="shell.js"></script></head>'
    "<body><script>throw new Error('the game never started');</script></body></html>"
)


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
            b = p.webkit.launch()
        except Exception as e:
            pytest.skip("WebKit is not installed: %s" % e)
        yield b
        b.close()


def _banner(page):
    return page.locator('[role="alert"]', has_text="failed to start").count()


def test_an_error_in_a_game_that_started_raises_no_banner(site, browser):
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.add_init_script(THROWS_BUT_PLAYS)
    page.goto(site + "truco.html")
    page.wait_for_timeout(GRACE_WAIT_MS)
    assert _banner(page) == 0
    page.close()


def test_a_game_that_drew_nothing_says_so(site, browser):
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.route(
        "**/blank-game.html",
        lambda r: r.fulfill(status=200, content_type="text/html", body=BLANK),
    )
    page.goto(site + "blank-game.html")
    page.wait_for_timeout(GRACE_WAIT_MS)
    assert _banner(page) == 1
    page.close()


def test_a_helper_script_that_fails_to_load_raises_no_banner_when_the_game_plays(site, browser):
    # Mahjong on Eric's phone: a helper failed to load over the network and the banner covered a full table.
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.route("**/recent.js*", lambda r: r.abort())
    page.goto(site + "mahjong.html")
    page.wait_for_timeout(GRACE_WAIT_MS)
    assert _banner(page) == 0
    page.close()


def test_a_game_whose_start_is_its_setup_sheet_raises_no_banner(site, browser):
    # ZimiKart on Eric's phone: an error while starting, the setup sheet up and the board not drawn until Start.
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.add_init_script("addEventListener('DOMContentLoaded', function () { setTimeout(function () { throw new Error('a stray start error'); }, 0); });")
    page.goto(site + "kart.html")
    page.wait_for_timeout(GRACE_WAIT_MS)
    assert page.locator(".ar-sheet:not([hidden])").count() == 1
    assert _banner(page) == 0
    page.close()


def test_the_banner_speaks_the_players_language_when_the_strings_loaded(site, browser):
    ctx = browser.new_context(locale="fr-FR", viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.route("**/blank-game.html", lambda r: r.fulfill(status=200, content_type="text/html", body=BLANK))
    page.goto(site + "blank-game.html")
    box = page.locator('[role="alert"]')
    box.wait_for(timeout=GRACE_WAIT_MS * 2)
    assert "pas pu démarrer" in box.inner_text()
    assert box.locator("button").inner_text() == "Recharger"
    ctx.close()


LATE = (
    '<!doctype html><html><head><meta charset="utf-8"><title>Late</title><script src="shell.js"></script></head>'
    "<body><script>throw new Error('a helper threw while the puzzle was still loading');</script>"
    "<script>setTimeout(function () { var c = document.createElement('canvas'); c.width = 300; c.height = 300;"
    " document.body.appendChild(c); }, 4000);"
    "</script></body></html>"
)


def test_a_game_that_draws_after_the_banner_takes_it_down(site, browser):
    # Eric saw it over a Loopy board on the NAS: something threw while the puzzle's wasm was still on its way, the
    # banner went up at the end of the grace, and then the board drew under it.
    page = browser.new_page(viewport={"width": 1000, "height": 800})
    page.route(
        "**/late-game.html",
        lambda r: r.fulfill(status=200, content_type="text/html", body=LATE),
    )
    told = []
    page.on(
        "request",
        lambda r: told.append(r.post_data_json) if r.url.endswith("/games/start-error") else None,
    )
    page.goto(site + "late-game.html")
    page.wait_for_timeout(3500)
    assert _banner(page) == 1
    page.wait_for_timeout(GRACE_WAIT_MS)
    assert _banner(page) == 0
    # Both moments reach Zimi's log, with the error that raised the banner.
    assert [m["outcome"].split(" ")[0] for m in told] == ["banner", "drew"], told
    assert "puzzle was still loading" in told[0]["why"], told
    page.close()


def test_a_script_from_another_site_that_fails_raises_no_banner_on_a_puzzle(site, browser):
    # Eric's Loopy over the internet, from Zimi's own log: "script did not load: https://static.cloudflareinsights.com/
    # beacon.min.js". Cloudflare adds that script to pages it serves; a blocker or the network dropped it, and the
    # puzzle's board (one canvas, nothing else) read as nothing drawn, so the banner stayed up over a working game.
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.route("https://static.cloudflareinsights.com/**", lambda r: r.abort())
    page.add_init_script(
        "addEventListener('DOMContentLoaded', function () { var s = document.createElement('script');"
        " s.src = 'https://static.cloudflareinsights.com/beacon.min.js/v1'; document.body.appendChild(s); });"
    )
    page.goto(site + "puzzles/loopy.html")
    page.wait_for_timeout(GRACE_WAIT_MS)
    assert page.locator("canvas").count() >= 1
    assert _banner(page) == 0
    page.close()


def test_the_server_logs_a_start_failure_and_caps_it(caplog):
    from zimi import http as zhttp

    zhttp._games_start_logged.clear()
    with caplog.at_level("WARNING", logger="zimi"):
        zhttp._log_games_start({"outcome": "banner", "page": "/w/zimi_games/puzzles/loopy.html", "why": "boom\nforged line"})
        for _ in range(zhttp._GAMES_START_LOG_PER_HOUR + 5):
            zhttp._log_games_start({"outcome": "banner", "page": "/x", "why": "again"})
    lines = [r.getMessage() for r in caplog.records if "ZimiGames start" in r.getMessage()]
    assert lines[0] == "ZimiGames start: banner on /w/zimi_games/puzzles/loopy.html: boom forged line"
    assert len(lines) == zhttp._GAMES_START_LOG_PER_HOUR
    zhttp._games_start_logged.clear()
