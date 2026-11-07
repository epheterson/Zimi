"""Defects found playing Shogi, Ur, Carrom, Ludo, Telephone, Bluff and Last Line on a phone: each test fails on the code before the fix.

Run: pytest tests/test_games_playthrough_polish.py -v
Set ZIMI_GAMES_DIR to run the same tests against another copy of the games folder (to prove them against older code).
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready, truthy  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.environ.get("ZIMI_GAMES_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
VIEW = {"width": 390, "height": 844}


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        for kind in (p.chromium, p.webkit):
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


@pytest.fixture
def open_game(served, browser):
    ctxs = []

    def go(name, query=""):
        ctx = browser.new_context(viewport=VIEW)
        ctxs.append(ctx)
        page = ctx.new_page()
        page.errors = []
        page.on("pageerror", lambda e: page.errors.append(str(e)))
        page.goto("%s/%s.html%s" % (served, name, query))
        return page

    yield go
    for c in ctxs:
        c.close()


def _pass_the_phone(page):
    page.locator("button:has-text('I am Player')").click()


def test_telephone_says_which_guess_was_wrong(open_game):
    """A wrong guess redrew the card, and the redraw cleared the line that said what was wrong."""
    page = open_game("telephone")
    game_ready(page, "__tp.g && __tp.g.secret")
    _pass_the_phone(page)
    page.fill("#tp-clue", "something people sometimes talk about at length")
    page.locator("button.gm-play").click()
    _pass_the_phone(page)
    secret = page.evaluate("__tp.g.secret.title")
    page.fill("#tp-search", "a")
    page.wait_for_selector("#tp-results button")
    wrong = [
        t for t in page.locator("#tp-results button").all_inner_texts() if t != secret
    ][0]
    page.locator("#tp-results button", has_text=wrong).first.click()
    frames(page, 3)
    assert wrong in page.inner_text("#tp-msg")


FAKES = ["a small tool for scraping fur", "the habit of whistling at dusk", "a sort of wet blanket made of felt"]


def test_bluff_final_scores_do_not_show_the_last_rounds_gain(open_game):
    """The Final scores board kept the "+3" of the round before it."""
    page = open_game("bluff")
    game_ready(page, "__bluff.g && __bluff.g.words.length")
    for _ in range(3):
        for i in range(3):
            _pass_the_phone(page)
            page.fill("#bl-fake", FAKES[i])
            page.locator("button.gm-play").click()
        for _ in range(3):
            _pass_the_phone(page)
            page.locator(".bl-option").first.click()
        page.locator("button.gm-play").click()   # Next, then See your score
    page.wait_for_function(truthy("__bluff.g.phase === 'done'"))
    rows = page.locator(".bl-board li span").all_inner_texts()
    assert len(rows) == 3 and not any("+" in r for r in rows), rows


def test_ludo_a_capture_does_not_stop_the_game(open_game):
    """list() read ZimiText.lang as a function, so the line about a captured token threw and the turn never moved on."""
    page = open_game("ludo", "?debug")
    game_ready(page, "__ld.state()")
    # Red's token at 1 and Green's lone token on the same ring square as Red's 3 (Green's 42): a 2 captures
    page.evaluate(
        "() => { const s = __ld.state(); s.tokens[0] = [1, -1, -1, -1]; s.tokens[1] = [42, -1, -1, -1]; __ld.force(2); }"
    )
    page.locator("#ld-die").click()
    page.wait_for_function(truthy("__ld.state().turn === 1"), timeout=15000)
    assert page.evaluate("__ld.state().tokens[1][0]") == -1
    assert not page.errors, page.errors


def test_ludo_a_win_sheet_does_not_repeat_its_title(open_game):
    page = open_game("ludo", "?debug")
    game_ready(page, "__ld.state()")
    page.evaluate(
        "() => { const s = __ld.state(); s.tokens[0] = [56, 56, 56, 55]; __ld.force(1); }"
    )
    page.locator("#ld-die").click()
    page.wait_for_function(truthy("__ld.state().winner === 0"), timeout=15000)
    page.wait_for_selector(".ar-sheet h2, .gs-sheet h2", timeout=10000)
    sheet = page.locator(".ar-sheet, .gs-sheet").last.inner_text()
    assert sheet.count("You win") == 0 and "You won" in sheet, sheet


def test_the_start_splash_hides_the_status_line_it_repeats(open_game):
    """The page's "Tap to start" line showed through the splash as a second copy of the splash's own hint."""
    page = open_game("lastline")
    page.wait_for_selector(".gs-splash")
    assert (
        page.evaluate("getComputedStyle(document.querySelector('.pl-msg')).visibility")
        == "hidden"
    )


def test_telephone_a_used_up_another_article_still_answers_a_tap(open_game):
    """After two swaps the button is greyed; a tap on it did nothing at all."""
    page = open_game("telephone")
    game_ready(page, "__tp.g && __tp.g.secret")
    _pass_the_phone(page)
    for _ in range(2):
        page.locator("button:has-text('Another article')").click()
        page.wait_for_selector("#tp-clue")
        frames(page, 3)
    page.locator("button:has-text('Another article')").click(force=True)   # aria-disabled: Playwright would wait forever
    assert page.locator("button:has-text('Another article')").evaluate("b => b.classList.contains('gs-shake') || b.classList.contains('gs-flash')")
