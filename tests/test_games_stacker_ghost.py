"""Stacker's landing ghost is drawn where a hard drop lands, for every piece, turn and wall kick, and a tall piece sitting
over it does not hide it.

The rules (StackerEngine.landing) are proved in test_games_play.cjs; this reads the canvas, which is what the player sees.

Run: pytest tests/test_games_stacker_ghost.py -v
"""

import functools
import http.server
import os
import threading

import pytest

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")

READ_GHOST = """() => {
  const S = window.StackerEngine, st = window.__stacker, g = st.g, cs = st.cell, HID = S.HIDDEN;
  const ctx = document.getElementById('st-board').getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const px = (x, y) => Array.from(ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);
  const lit = (c) => (c[0] + c[1] + c[2]) > 120;           // the well is #0e0e10 (sum 44): the outline and tint are well above it
  st.draw();
  const marked = S.landing(g).filter(p => p[1] >= HID);
  // the outline runs along the inside of each cell's border: sample the middle of its left edge
  const seen = marked.map(p => lit(px(p[0] * cs + Math.max(1, cs * 0.06) + 1, (p[1] - HID) * cs + cs / 2)));
  return { n: marked.length, seen };
}"""

SETUP = """([type, rot, x, y, dir, stack]) => {
  const S = window.StackerEngine, st = window.__stacker, g = st.g;
  g.board = S.emptyBoard();
  if (stack) for (let r = 14; r < S.ROWS; r++) for (let c = 0; c < S.COLS; c++) if (c % 3 !== 1 || r > 18) g.board[r][c] = 1;
  g.cur = { type, rot, x, y };
  if (dir) { if (!S.rotate(g, dir)) return false; }
  return true;
}"""


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def page(site):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.webkit.launch()
        pg = b.new_page(viewport={"width": 390, "height": 844})
        pg.goto(site + "stacker.html")
        pg.wait_for_function("() => window.__stacker && window.__stacker.g")
        yield pg
        b.close()


@pytest.mark.parametrize("stack", [False, True], ids=["empty well", "ragged stack"])
def test_every_piece_every_turn_every_kick_shows_where_it_lands(page, stack):
    shown = checked = 0
    for t in "IOTSZJL":
        for rot in range(4):
            # in open water, then against each wall, where the turns have to kick
            for x in (-2, 0, 3, 7):
                for d in (1, -1):
                    if not page.evaluate(SETUP, [t, rot, x, 3, d, stack]):
                        continue
                    r = page.evaluate(READ_GHOST)
                    checked += 1
                    assert r["n"] == 0 or all(r["seen"]), (t, rot, x, d, r)
                    shown += r["n"] > 0
    assert checked > 100 and shown > 50, (checked, shown)


def test_a_tall_piece_just_above_its_landing_still_shows_it(page):
    # a vertical I three rows above the floor: its landing overlaps its own cells
    assert page.evaluate(SETUP, ["I", 1, 3, 16, 0, False])
    r = page.evaluate(READ_GHOST)
    assert r["n"] == 4 and all(r["seen"]), r
