"""Janggi in a browser: the arrangement chosen in New game is the one on the board, it comes back with a saved game, and
bikjang asks the side to move to break it or pass (a pass is a draw).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_janggi_browser.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

FEN = "(() => __jg.engine.toFen(__jg.pos()))()"


def open_janggi(browser, served, settings):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('zimi.games.janggi.settings', %s); }" % json.dumps(json.dumps(settings)))
    page.goto("%s/janggi.html?debug" % served)
    page.wait_for_function("window.__jg && document.querySelectorAll('.jg-pt').length === 90")
    return ctx, page, errors


@pytest.mark.parametrize("setup,cho,han", [
    ("inside", "RHEA1AEHR", "rhea1aehr"),
    ("outside", "REHA1AHER", "reha1aher"),
    ("left", "RHEA1AHER", "reha1aehr"),
    ("right", "REHA1AEHR", "rhea1aher"),
])
def test_the_chosen_arrangement_is_on_the_board(served, browser, setup, cho, han):
    ctx, page, errors = open_janggi(browser, served, {"mode": "cpu", "level": "easy", "side": "first", "setup": setup})
    rows = page.evaluate(FEN).split(" ")[0].split("/")
    assert rows[9] == cho and rows[0] == han
    assert not errors
    ctx.close()


def test_a_saved_game_comes_back_with_its_arrangement(served, browser):
    ctx, page, errors = open_janggi(browser, served, {"mode": "two", "level": "easy", "side": "first", "setup": "right"})
    start = page.evaluate(FEN)
    # a soldier steps up; leave and come back
    page.locator(".jg-pt[data-d='56']").click()
    page.locator(".jg-pt[data-d='47']").click()
    page.wait_for_function("__jg.pos().undo.length === 1")
    after = page.evaluate("(() => { window.dispatchEvent(new Event('pagehide')); return __jg.engine.toFen(__jg.pos()); })()")
    page.reload()
    page.wait_for_function("window.__jg && __jg.pos().undo.length === 1")
    assert page.evaluate(FEN) == after
    rows = start.split(" ")[0].split("/")
    assert rows[9] == "REHA1AEHR" and rows[0] == "rhea1aher"
    ctx.close()
    assert not errors


def test_bikjang_asks_to_break_it_or_pass_and_a_pass_is_a_draw(served, browser):
    ctx, page, errors = open_janggi(browser, served, {"mode": "cpu", "level": "easy", "side": "first", "labels": "han"})
    page.evaluate("__jg.setFen('4k4/9/9/9/9/9/9/9/R8/4K4 w')")
    status = page.locator("#wk-status")
    status.wait_for()
    page.wait_for_function("document.getElementById('wk-status').textContent.indexOf('Bikjang') >= 0")
    # only breaking moves are offered: the rook may step between the generals, the general may step off the file
    page.locator(".jg-pt[data-d='72']").click()   # a2 (the rook)
    assert page.locator(".jg-pt.hint").count() == 1
    page.locator(".jg-pt[data-d='72']").click()
    page.locator("#jg-pass").click()
    page.wait_for_selector(".ar-sheet")
    assert "draw" in page.locator(".ar-sheet").inner_text().lower()
    ctx.close()
    assert not errors
