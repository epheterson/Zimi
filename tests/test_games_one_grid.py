"""Every game board made of cells reads as one ARIA grid, and only ZimiUtil makes it one.

The pattern (docs/design/games.md, Accessibility) lives in util.js: gridAria gives the board role=grid, rows and gridcells,
gridRove one tab stop and the arrow keys. A game that set the roles itself or walked its cells with its own arrow keys would
drift from the others, so the source is checked for both, and each cell board is opened to see the grid it ends up with.
"""

import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(HERE, "..", "zimi", "builtin", "games")

ROLE_SET = re.compile(
    r"""setAttribute\(\s*['"]role['"]\s*,\s*['"](?:grid|gridcell|row)['"]|role=["'](?:grid|gridcell|row)["']"""
)
# Files that answer the arrow keys with their own focus moves, and why that is not a board of cells.
OWN_ARROWS = {
    "util.js": "the one grid pattern itself",
    "cards.js": "up and down within one pile of cards",
    "mahjong.js": "free tiles in a heap, by where they lie",
    "sudoku.js": "a selection that walks the grid ZimiUtil made, with the number pad beside it",
    "tilemenu.js": "a menu list",
    "whereintheworld.js": "a pin moved over a map",
    "worldkit.js": "calls ZimiUtil for its overlays",
}
# Boards of cells, as a person sees them: each must open with a grid.
CELL_BOARDS = (
    "checkers.html",
    "chess.html",
    "chessopenings.html",
    "chesspuzzles.html",
    "draughts.html",
    "fiveletters.html",
    "fleet.html",
    "go.html",
    "gomoku.html",
    "hex.html",
    "hnefatafl.html",
    "janggi.html",
    "makruk.html",
    "memory.html",
    "minesweeper.html",
    "minicrossword.html",
    "noughts.html",
    "reversi.html",
    "shogi.html",
    "sudoku.html",
    "xiangqi.html",
)


def _sources():
    for name in sorted(os.listdir(GAMES_DIR)):
        if name.endswith((".js", ".html")):
            with open(os.path.join(GAMES_DIR, name), encoding="utf-8") as f:
                yield name, f.read()


def test_only_util_sets_grid_roles():
    found = [
        name for name, src in _sources() if name != "util.js" and ROLE_SET.search(src)
    ]
    assert not found, (
        "these set grid, row or gridcell themselves instead of ZimiUtil.gridAria: %s"
        % found
    )


def test_no_game_walks_its_cells_with_its_own_arrow_keys():
    found = [
        name
        for name, src in _sources()
        if name.endswith(".js")
        and "ArrowUp" in src
        and ".focus()" in src
        and name not in OWN_ARROWS
    ]
    assert not found, (
        "these move focus with arrow keys themselves instead of ZimiUtil.gridRove: %s"
        % found
    )


pytest.importorskip("playwright")
sys.path.insert(0, HERE)
from test_games_trick_fixtures import browser, served  # noqa: E402,F401

GRID_SHAPE = """() => [...document.querySelectorAll('[role=grid]')].map(g => {
  const rows = [...g.querySelectorAll('[role=row]')], cells = [...g.querySelectorAll('[role=gridcell]')];
  return { rows: rows.length, cells: cells.length, loose: cells.filter(c => c.parentElement.getAttribute('role') !== 'row').length,
           cols: +g.getAttribute('aria-colcount'), stops: cells.filter(c => c.tabIndex === 0).length };
})"""


@pytest.mark.parametrize("path", CELL_BOARDS)
def test_a_cell_board_opens_as_a_grid(browser, served, path):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
    )
    page = ctx.new_page()
    try:
        page.goto("%s/%s" % (served, path))
        page.wait_for_function(
            "document.querySelector('[role=gridcell]')", timeout=8000
        )
        grids = page.evaluate(GRID_SHAPE)
    finally:
        ctx.close()
    assert grids, "%s has no grid" % path
    for g in grids:
        assert g["cells"] and not g["loose"], "%s: every gridcell sits in a row: %s" % (
            path,
            g,
        )
        assert (
            g["rows"] * g["cols"] >= g["cells"]
        ), "%s: rows and columns cover the cells: %s" % (path, g)
