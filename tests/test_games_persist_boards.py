"""The board and tile games keep their position across leaving the page and coming back (ZimiShell.persist).

One row per game: the page, the taps that make a move (a list, in order, the first match of each selector),
and JS that returns the position as a string. The world-kit games answer ZimiGameSave(): the page's own state
plus the options in force. The shared fixtures and the tap helper are in test_games_persist_browser.py.

Run: pytest tests/test_games_persist_boards.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import PENDING_TIMERS_JS, becomes, frames, game_ready, timers_idle, truthy  # noqa: E402
from test_games_persist_browser import VIEW, browser, leave, served, tap  # noqa: E402,F401

from playwright.sync_api import TimeoutError as PlaywrightTimeout  # noqa: E402

REPLY_MS = 60000   # how long to give the computer to finish its reply; the read after is atomic with the save, so a reply that is still coming costs nothing

SAVE = "ZimiGameSave()"
# moves that need the page's own hooks (?debug) or a wait for the person's turn
CC_MOVE = """(function () { var c = __cc, s = c.state();
  for (var i = 0; i < s.owner.length; i++) {
    if (s.owner[i] === 1) { var to = Object.keys(c.engine.movesFrom(s, i)).filter(function (k) { return +k !== i; }); if (to.length) { c.tap(i); c.tap(+to[0]); return 1; } }
  } })()"""
# These wait in the page for the person's turn by a deadline, not a count of tries: the computers' turns take as long as the machine takes.
LUDO_MOVE = """(async function () {
  var end = Date.now() + 240000;
  while (Date.now() < end) {
    if (__ld.state().turn === 0 && __ld.phase() === 'roll') { __ld.force(6); __ld.roll(); }   // a six brings a token out, so the first turn has a move
    await new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 30); }); });
    if (__ld.state().turn === 0 && __ld.phase() === 'move' && __ld.legal().length) { __ld.choose(__ld.legal()[0]); return 1; }
  } return 0; })()"""
# (Dominoes: the person's move if there is one to make; the game is just as well kept once anyone has moved: the point is that it is kept.)
DOMINO_MOVE = """(async function () {
  var end = Date.now() + 240000;
  while (Date.now() < end) {
    if (ZimiGameSave()) return 2;
    var card = document.querySelector('.dm-card.can');
    if (card) {
      card.click();   // one end to play: it is played; two: the ends are offered as ghosts to tap
      while (Date.now() < end) {
        var g = document.querySelector('.dm-tile.ghost');
        if (g) { g.click(); return 1; }
        if (ZimiGameSave()) return 1;
        await new Promise(function (r) { requestAnimationFrame(r); });
      }
    }
    await new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 30); }); });
  } return 0; })()"""
ROWS = [
    ("fourinarow", [".fr-col:nth-child(4)"], SAVE),
    ("gomoku", [".wk-board button:nth-child(113)"], SAVE),
    ("hex", [".wk-board button:nth-child(60)"], SAVE),
    ("dotsandboxes", [".db-edge:nth-child(3)"], SAVE),
    ("morris", [".mo-pt:nth-child(5)"], SAVE),
    ("reversi", [".bg-sq.hint"], SAVE),
    ("checkers", [".bg-sq:has(.ck-pc.r.mv)", ".bg-sq.hint"], SAVE),
    ("mancala", [".mc-pit-btn[aria-disabled=false]"], SAVE),
    ("go", [".go-pt:nth-child(41)"], SAVE),
    ("ur", ["#ur-roll"], SAVE),
    ("carrom", ["#cr-shoot"], SAVE),
    ("draughts", (".bg-sq.can", ".bg-sq.hint"), SAVE),
    ("hnefatafl", (".hn-sq:has(.hn-pc)", ".hn-sq.hint"), SAVE),
    ("janggi", (".jg-pt:has(.jg-pc.cho)", ".jg-pt.hint"), SAVE),
    ("makruk", (".bg-sq:has(.mk-pc.w)", ".bg-sq.hint"), SAVE),
    ("backgammon", [], SAVE),
    ("chinesecheckers", ["js:" + CC_MOVE], SAVE, None, "?debug"),
    ("ludo", ["js:" + LUDO_MOVE], SAVE, None, "?debug"),
    ("dominoes", ["js:" + DOMINO_MOVE], SAVE),
    ("mahjong", [".mj-t:not(.blocked)"], "(function () { var d = JSON.parse(ZimiGameSave()); delete d.seconds; return JSON.stringify(d); })()"),   # the clock runs on
    ("fleet", ["#fl-tools .ar-btn:nth-child(2)"], SAVE),
    ("chesspuzzles", [], SAVE),
    ("chessopenings", [], SAVE),
    ("goproblems", ["js:__gp.play(__gp.problem().f[0])"], SAVE, None, "?debug"),
    ("mahjong4", [".m4-hand .m4-t", ".m4-hand .m4-t"], SAVE),
    ("chess", (".bg-sq:has(.cs-pc.w)", ".bg-sq.hint"), SAVE),
    ("xiangqi", (".xq-pt:has(.xq-pc.r)", ".xq-pt.hint"), SAVE),
    ("shogi", (".sg-sq:has(.sg-pc:not(.g))", ".sg-sq.hint"), SAVE),
]


@pytest.mark.parametrize("row", ROWS, ids=[r[0] for r in ROWS])
def test_leaving_and_returning_keeps_the_position(served, browser, row):
    page_name, moves, position = row[:3]
    query = row[4] if len(row) > 4 else ""   # ?debug where the test needs the page's own hooks
    ctx = browser.new_context(viewport=VIEW)
    ctx.add_init_script(PENDING_TIMERS_JS)
    page = ctx.new_page()
    url = "%s/%s.html%s" % (served, page_name, query)
    page.goto(url)
    game_ready(page)   # (the position reads as nothing until a move is made; the first tap waits for its own element)
    if isinstance(moves, tuple):
        # (own pieces, targets): tap pieces until one shows somewhere to go, then go
        pieces, target = moves
        page.locator(pieces).first.wait_for(state="visible")
        for i in range(page.locator(pieces).count()):
            tap(page, page.locator(pieces).nth(i))
            if page.locator(target).count():
                break
        tap(page, page.locator(target).first)
    else:
        for sel in moves:
            if sel.startswith("js:"):
                page.evaluate(sel[3:])
                frames(page)
            else:
                tap(page, page.locator(sel).first)
    page.wait_for_function(truthy(position), timeout=REPLY_MS)   # a sowing, a roll, a shot or a deal that is still playing has no position to keep yet
    try:
        timers_idle(page, timeout=REPLY_MS)   # the computer's reply has landed, where there is one
    except PlaywrightTimeout:
        pass   # a game that keeps a timer running (a clock) never goes idle: the read below is the same breath as the save either way
    before = leave(page, position)
    assert before, "a move was made, so there is a position to keep"
    page.goto("about:blank")
    page.goto(url)
    game_ready(page, position)
    becomes(page, position, before)   # put back once the game's own start has run; a miss shows in the assert
    after = page.evaluate(position)
    assert after == before, "the position came back different after leaving and returning"
    ctx.close()
