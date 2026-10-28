"""A Tatham puzzle left mid-game comes back as it was, undo history included.

The puzzle pages (zimi-fit.js) keep the frontend's own save text with ZimiShell.persist. A move, then the page is
hidden, then the puzzle is opened again: the same save text is the position.

Run: pytest tests/test_games_persist_puzzles.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, shell_ready, truthy  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SAVE_TEXT = "(() => { const c = Module.cwrap; const p = c('get_save_file', 'number', [])(); const t = UTF8ToString(p); c('free_save_file', 'void', ['number'])(p); return t; })()"
RUNNING = "document.documentElement.classList.contains('zf-running')"   # the puzzle is up and its saved game, if any, is back
CAN_UNDO = "!document.getElementById('undo').disabled"
# a puzzle, then what to press until a move has been made: a key, or "x,y" as a fraction of the canvas
ROWS = [
    ("fifteen", ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]),
    ("keen", ["0.1,0.1", "1", "0.3,0.3", "2"]),
    ("net", ["0.5,0.5", "0.3,0.7"]),
    # No status bar on these two (the frontend removes it), so the save is the only thing that says where the game was.
    # The deal is random and a tap on a black clue square is no move: enough taps that one lands on a white square.
    ("lightup", ["0.3,0.3", "0.6,0.5", "0.45,0.75", "0.75,0.2", "0.15,0.6"]),
    ("pattern", ["0.5,0.5", "0.3,0.7"]),
]


def press(page, what):
    if "," in what:
        box = page.locator("#puzzlecanvas").bounding_box()
        fx, fy = (float(v) for v in what.split(","))
        page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
    else:
        page.keyboard.press(what)
    frames(page)


@pytest.mark.parametrize("name,moves", ROWS, ids=[r[0] for r in ROWS])
def test_a_puzzle_comes_back_as_it_was(served, browser, name, moves):  # noqa: F811
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    url = "%s/puzzles/%s.html" % (served, name)
    page.goto(url)
    shell_ready(page)
    page.wait_for_function(truthy("typeof command === 'function'"))
    page.locator("#puzzlecanvas").focus()
    for m in moves:
        press(page, m)
    page.wait_for_function(truthy(CAN_UNDO))
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    before = page.evaluate(SAVE_TEXT)
    assert page.evaluate("ZimiShell.saved()"), "a puzzle with a move in it is kept"
    page.goto("about:blank")
    page.goto(url)
    shell_ready(page)
    page.wait_for_function(truthy(CAN_UNDO))   # the loaded game has its history
    assert page.evaluate(SAVE_TEXT) == before, "the puzzle came back different after leaving and returning"
    ctx.close()


@pytest.mark.parametrize("name", ["bridges", "loopy"])
def test_a_dealt_puzzle_comes_back_as_dealt(served, browser, name):  # noqa: F811
    """Leaving before the first move still keeps the puzzle: the one that comes back is the one that was dealt, not a new one."""
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    url = "%s/puzzles/%s.html" % (served, name)
    page.goto(url)
    shell_ready(page)
    page.wait_for_function(truthy(RUNNING))
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    before = page.evaluate(SAVE_TEXT)
    assert page.evaluate("ZimiShell.saved()"), "a dealt puzzle is kept too"
    page.goto("about:blank")
    page.goto(url)
    shell_ready(page)
    page.wait_for_function(truthy(RUNNING))
    assert page.evaluate(SAVE_TEXT) == before, "a different puzzle came back"
    ctx.close()


# Yacht and Liar's Dice keep their generator's place too: the next roll, the next computer's bid, are the ones that were next.
YACHT = "JSON.stringify(YachtEngine.snapshot(__yacht.g))"
LIARS = "JSON.stringify(LiarsDiceEngine.snapshot(__liarsdice.g)) + String(!document.getElementById('ld-reveal').hidden)"


def start(page, go):
    page.locator(go).wait_for(state="visible")
    page.click(go)
    frames(page)


def comes_back(page, url, position, ready):
    """Leave and read in one breath, reload, and read again: the same position."""
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    before = page.evaluate(position)
    assert page.evaluate("ZimiShell.saved()"), "something is kept"
    page.goto("about:blank")
    page.goto(url)
    shell_ready(page)
    page.wait_for_function(truthy(ready))
    assert page.evaluate(position) == before, "the position came back different after leaving and returning"


def test_yacht_comes_back_mid_turn(served, browser):  # noqa: F811
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    url = served + "/yacht.html"
    page.goto(url)
    shell_ready(page)
    start(page, "#yc-go")
    page.click("#yc-roll")
    page.wait_for_function(truthy("__yacht.g.rollsLeft === 2"))
    page.click(".pl-die >> nth=0")   # keep one die
    page.click("#yc-roll")
    page.wait_for_function(truthy("__yacht.g.rollsLeft === 1"))
    comes_back(page, url, YACHT, "__yacht.g.rollsLeft === 1 && document.querySelector('.ar-sheet[hidden]')")
    page.click("#yc-roll")   # the roll that comes next is the same one it would have been
    ctx.close()


def test_liars_dice_comes_back_after_a_bid(served, browser):  # noqa: F811
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    url = served + "/liarsdice.html"
    page.goto(url)
    shell_ready(page)
    start(page, "#ld-go")
    page.wait_for_function(truthy("document.getElementById('ld-bidbtn').getAttribute('aria-disabled') !== 'true'"))
    page.click("#ld-bidbtn")
    # every computer has answered: it is my turn again (Liar is open to me, after a bid that is not mine) or a call has put the reveal up; either way nothing is moving
    page.wait_for_function(truthy("(document.getElementById('ld-liar').getAttribute('aria-disabled') !== 'true' && __liarsdice.g.bid && __liarsdice.g.bid.by !== 0) || !document.getElementById('ld-reveal').hidden"))
    comes_back(page, url, LIARS, "__liarsdice.g.bid || __liarsdice.g.last")
    # then the call itself: the reveal of every die is on screen, and it is still there after coming back
    if page.locator("#ld-reveal").evaluate("e => e.hidden"):
        page.wait_for_function(truthy("document.getElementById('ld-liar').getAttribute('aria-disabled') !== 'true'"))
        page.click("#ld-liar")
    page.wait_for_function(truthy("!document.getElementById('ld-reveal').hidden"))
    comes_back(page, url, LIARS, "!document.getElementById('ld-reveal').hidden")
    page.click("#ld-next")   # on to the next round
    ctx.close()
