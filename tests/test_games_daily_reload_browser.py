"""A daily survives a reload, and a tab the phone evicted: the address names the day, and the progress comes back.

A playtester opened Sudoku from the shelf's Today tile, entered a digit and reloaded (as iOS does to an evicted tab): a random
puzzle opened, no "Today's daily" label, the progress gone, because Zimi's address kept /?a=zimi_games/sudoku.html and dropped
the ?daily=. The query now rides in the ?a= deep link (and follows the page when it changes its own address, as leaving a
daily for an ordinary game does).

Run: pytest tests/test_games_daily_reload_browser.py -v
"""

import os
import sys
from urllib.parse import unquote

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_daily_reader_live import PHONE, _game_frame, zimi  # noqa: E402,F401

DAY = "2026-11-04"
# One of each kind of daily: seeded cards, a Tatham puzzle, and the games with their own daily (a word, a crossword, a puzzle set).
PAGES = [
    "sudoku.html",
    "freecell.html",
    "solitaire.html",
    "minesweeper.html",
    "fiveletters.html",
    "minicrossword.html",
    "spellingbee.html",
    "chesspuzzles.html",
    "puzzles/loopy.html",
]


def _open_daily(page, base, path):
    page.goto(base + "/?a=zimi_games%2Findex.html")
    shelf = _game_frame(page, "/w/zimi_games/index.html")
    shelf.wait_for_selector("a.ar-game", state="attached", timeout=20000)
    shelf.evaluate(
        "([p, d]) => { const a = document.createElement('a'); a.id = 'daily-link'; a.href = p + '?daily=' + d; a.textContent = 'Daily'; document.body.prepend(a); }",
        [path, DAY],
    )
    shelf.click("#daily-link")
    return _game_frame(page, "/w/zimi_games/" + path)


@pytest.mark.parametrize("path", PAGES)
def test_a_daily_is_named_by_the_address_and_reloads_as_the_daily(zimi, path):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport=PHONE).new_page()
        game = _open_daily(page, zimi.base, path)
        assert path + "?daily=" + DAY in game.url
        page.wait_for_timeout(600)
        assert unquote(page.url).endswith("a=zimi_games/" + path + "?daily=" + DAY)
        page.reload()
        game = _game_frame(page, "/w/zimi_games/" + path)
        assert path + "?daily=" + DAY in game.url
        b.close()


def test_a_sudoku_daily_keeps_its_progress_through_a_reload(zimi):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport=PHONE).new_page()
        game = _open_daily(page, zimi.base, "sudoku.html")
        game.wait_for_selector(".su-c:not(.given)", timeout=20000)
        cells = "() => [...document.querySelectorAll('.su-c')].map(c => c.classList.contains('given') ? 'g' : c.textContent.trim()).join('|')"
        before = game.evaluate(cells)
        empty = next(i for i, c in enumerate(before.split("|")) if c != "g")
        game.locator(".su-c").nth(empty).click()
        game.locator(".su-num[data-d='5']").click()
        page.wait_for_timeout(800)
        entered = game.evaluate(cells)
        assert entered != before
        page.reload()
        game = _game_frame(page, "/w/zimi_games/sudoku.html")
        game.wait_for_selector(".su-c:not(.given)", timeout=20000)
        page.wait_for_timeout(800)
        assert game.evaluate(cells) == entered
        assert "daily" in game.evaluate("() => document.body.innerText").lower()
        b.close()


def test_leaving_the_daily_for_a_new_game_drops_it_from_the_address(zimi):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport=PHONE).new_page()
        game = _open_daily(page, zimi.base, "sudoku.html")
        game.wait_for_selector(".su-c", timeout=20000)
        game.evaluate("() => ZimiShell.leaveDaily()")
        for _ in range(40):
            if "daily" not in unquote(page.url):
                break
            page.wait_for_timeout(250)
        assert "daily" not in unquote(page.url)
        page.reload()
        game = _game_frame(page, "/w/zimi_games/sudoku.html")
        assert "daily=" not in game.url
        b.close()
