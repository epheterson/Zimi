"""A daily is the same game for everyone: a player's own settings, the game's menu and a ?seed= in the address cannot make
it another game (Code Breaker's repeats, Spider's suits, Minesweeper's board).

Run: pytest tests/test_games_daily_locks_browser.py -v
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
DAY = "2026-11-04"
PHONE = {"width": 390, "height": 844}


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass


@pytest.fixture(scope="module")
def site():
    srv = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(_Quiet, directory=GAMES)
    )
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


def _page(browser, url, storage=None):
    ctx = browser.new_context(viewport=PHONE)
    if storage:
        ctx.add_init_script(
            "(s => { for (const k in s) localStorage.setItem(k, s[k]); })(%s)"
            % __import__("json").dumps(storage)
        )
    pg = ctx.new_page()
    pg.goto(url)
    return ctx, pg


def test_a_code_breaker_daily_has_no_repeats_whatever_the_setting(site, browser):
    ctx, pg = _page(
        browser,
        site + "codebreaker.html?daily=" + DAY,
        {"zimi.games.codebreaker.settings": '{"repeats":true}'},
    )
    try:
        pg.wait_for_function("() => window.__codebreaker && window.__codebreaker.cur")
        first = pg.locator("#cb-palette button, .cb-palette button").first
        first.click()
        first.click(force=True)
        cur = pg.evaluate("() => window.__codebreaker.cur.slice()")
        assert (
            cur.count(cur[0]) == 1
        ), cur  # the second press of the same colour is refused
    finally:
        ctx.close()


def test_a_spider_daily_keeps_two_suits_when_the_menu_picks_four(site, browser):
    ctx, pg = _page(browser, site + "spider.html?daily=" + DAY)
    try:
        pg.wait_for_selector(".zc-card[data-id]", state="attached")
        pg.wait_for_timeout(2500)
        deal = pg.eval_on_selector_all(
            ".zc-card[data-id]", "els => els.map(e => e.getAttribute('data-id')).join()"
        )
        # The game's suit choice, taken from its menu as the shell's New game pane takes it.
        pg.evaluate(
            """() => { const real = ZimiCards.sheet; let taken = null;
          ZimiCards.sheet = (o) => { taken = o; return { el: null, close() {} }; };
          try { document.getElementById('zc-menu').click(); } finally { ZimiCards.sheet = real; }
          const host = document.createElement('div'); taken.body.forEach(n => host.appendChild(n)); document.body.appendChild(host);
          [...host.querySelectorAll('button')].find(b => /4/.test(b.textContent)).click(); }"""
        )
        pg.wait_for_timeout(2500)
        again = pg.eval_on_selector_all(
            ".zc-card[data-id]", "els => els.map(e => e.getAttribute('data-id')).join()"
        )
        assert again == deal
    finally:
        ctx.close()


def test_a_minesweeper_daily_ignores_a_seed_in_its_address(site, browser):
    boards = []
    for extra in ("", "&seed=5"):
        ctx, pg = _page(browser, site + "minesweeper.html?daily=" + DAY + extra)
        try:
            pg.wait_for_function("() => window.__ms && window.__ms.game()")
            g = pg.evaluate(
                "() => { const g = window.__ms.game(); return { rows: g.rows, cols: g.cols, mines: g.mines, first: g.rng() }; }"
            )
            boards.append(g)
        finally:
            ctx.close()
    assert boards[0] == boards[1], boards
    assert boards[0]["rows"] == 16 and boards[0]["cols"] == 16, boards[
        0
    ]  # the day's intermediate board
