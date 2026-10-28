"""Simon Tatham's puzzles as ZimiGames pages: a win is a win only when the player makes it, and Undo and Redo are in the bar.

Light Up has no status bar, so its win is read from the completion flash (zimi-fit.js watchFlash). The solver finds the lamps
(the SOLVE line of the save text); the test undoes it and places them with the keyboard, as a player would.

Run: pytest tests/test_games_puzzles.py -v
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, shell_ready, truthy  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SAVE_TEXT = "(() => { const c = Module.cwrap; const p = c('get_save_file', 'number', [])(); const t = UTF8ToString(p); c('free_save_file', 'void', ['number'])(p); return t; })()"
RUNNING = "document.documentElement.classList.contains('zf-running')"
WIN_SHEET = ".ar-sheet h2"
SOLVED_SHEET_WAIT_MS = 8000


def open_lightup(browser, served):  # noqa: F811
    page = browser.new_context(viewport=VIEW).new_page()
    page.goto("%s/puzzles/lightup.html" % served)
    shell_ready(page)
    page.wait_for_function(truthy(RUNNING))
    return page


def lamps(page):
    """Ask the solver, take its lamps from the save text, and take the solution back."""
    page.evaluate("document.getElementById('solve').click()")
    saved = page.evaluate(SAVE_TEXT)
    page.evaluate("document.getElementById('undo').click()")
    frames(page)
    width = int(re.search(r"PARAMS\s*:\d+:(\d+)x", saved).group(1))
    return width, [(int(x), int(y)) for x, y in re.findall(r"L(\d+),(\d+)", re.search(r"SOLVE\s*:\d+:(.*)", saved).group(1))]


def place(page, width, cells):
    page.locator("#puzzlecanvas").focus()
    for _ in range(width + 1):
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowUp")
    cx = cy = 0
    for x, y in cells:
        for key, n in (("ArrowRight", x - cx), ("ArrowLeft", cx - x), ("ArrowDown", y - cy), ("ArrowUp", cy - y)):
            for _ in range(max(0, n)):
                page.keyboard.press(key)
        cx, cy = x, y
        page.keyboard.press("Enter")
        frames(page)


def test_solving_it_yourself_is_a_win_with_a_time_and_a_best(served, browser):  # noqa: F811
    page = open_lightup(browser, served)
    width, cells = lamps(page)
    place(page, width, cells)
    page.wait_for_selector(WIN_SHEET, timeout=SOLVED_SHEET_WAIT_MS)
    text = page.inner_text(".ar-sheet")
    assert re.search(r"\d+:\d\d", text), "the win sheet carries the time"
    assert page.evaluate("JSON.parse(localStorage.getItem('zimi.games.puzzleBest')).lightup") , "the best time is kept"
    page.context.close()


def test_the_solver_is_never_a_win(served, browser):  # noqa: F811
    page = open_lightup(browser, served)
    page.click(".gs-menu-btn")
    page.click("#pz-solve")
    page.wait_for_selector(".ar-sheet .gs-primary")   # it asks first
    page.click(".ar-sheet .gs-primary")
    frames(page, 60)
    assert page.locator(".ar-sheet h2:has-text('win')").count() == 0
    assert not page.evaluate("localStorage.getItem('zimi.games.puzzleBest')")
    page.context.close()


def test_undo_and_redo_are_bar_buttons_that_appear_with_a_move(served, browser):  # noqa: F811
    page = open_lightup(browser, served)
    assert page.locator(".ar-bar #pz-undo").is_hidden(), "nothing to undo yet"
    box = page.locator("#puzzlecanvas").bounding_box()
    # The deal is random: a tap on a black clue square is no move, so tap down the diagonal until one is a lamp.
    for share in (0.3, 0.45, 0.6, 0.75, 0.15, 0.9):
        page.mouse.click(box["x"] + box["width"] * share, box["y"] + box["height"] * share)
        frames(page)
        if page.locator(".ar-bar #pz-undo").is_visible():
            break
    assert page.locator(".ar-bar #pz-undo").is_visible()
    page.click(".ar-bar #pz-undo")
    frames(page)
    assert page.locator(".ar-bar #pz-redo").is_visible(), "an undone move can be redone"
    page.context.close()


def test_pattern_is_a_win_though_it_flashes_for_no_time(served, browser):  # noqa: F811
    """Pattern has no status bar and no flash to time: its win is judged from the clues in the save text. The solver's squares are
    undone first, so this also shows that a taken-back solution no longer blocks a win."""
    page = browser.new_context(viewport=VIEW).new_page()
    page.goto("%s/puzzles/pattern.html" % served)
    shell_ready(page)
    page.wait_for_function(truthy(RUNNING))
    page.evaluate("document.getElementById('solve').click()")
    saved = page.evaluate(SAVE_TEXT)
    page.evaluate("document.getElementById('undo').click()")
    frames(page)
    width = int(re.search(r"PARAMS\s*:\d+:(\d+)x", saved).group(1))
    bits = re.search(r"SOLVE\s*:\d+:S(.*)", saved).group(1)
    place(page, width, [(i % width, i // width) for i, ch in enumerate(bits) if ch == "1"])
    page.wait_for_selector(WIN_SHEET, timeout=SOLVED_SHEET_WAIT_MS)
    page.context.close()
