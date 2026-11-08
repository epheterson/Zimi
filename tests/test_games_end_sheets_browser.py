"""The end of a game never sits on what was just done: the sheet is at the bottom, the win's stamp lands in free space, and a
daily's sheet says time, hints, streak and has Share and Close.

A playtester saw the Mini Crossword's win sheet over the bottom of the grid with only "Hints 0" on it (no time, no streak),
Spelling Bee's resting bar under the Zimi mark, and Go's big stamp land on the stats line a second after Accept score.

Run: pytest tests/test_games_end_sheets_browser.py -v
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
DAY = "2026-11-06"


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
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


def _page(browser, site, url, scheme="dark"):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        color_scheme=scheme,
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(site + url)
    return pg


def _solve_crossword(pg):
    pg.wait_for_function(
        "() => window.__cw && window.__cw.g && window.__cw.sol", timeout=15000
    )
    pg.wait_for_selector(".cw-cell, .mc-cell, [data-i]", state="attached")
    # one second of play, then every cell but the last filled in, the last typed by the keyboard
    pg.keyboard.press("a")
    pg.wait_for_timeout(2300)
    last = pg.evaluate("""() => {
          const z = window.__cw, g = z.g, idx = z.sol.map((l, i) => l ? i : -1).filter((i) => i >= 0);
          const lastI = idx[idx.length - 1];
          idx.forEach((i) => { if (i !== lastI) g.cells[i] = z.sol[i]; });
          g.cells[lastI] = '';
          g.sel = lastI;
          return z.sol[lastI];
        }""")
    pg.keyboard.press(last)
    return pg.wait_for_selector(".ar-sheet.gs-end .ar-sheet-card", timeout=15000)


def test_a_crossword_win_sheet_has_time_hints_streak_share_and_close_and_leaves_the_grid(
    browser, site
):
    pg = _page(browser, site, "minicrossword.html?daily=" + DAY)
    card = _solve_crossword(pg)
    text = card.inner_text()
    assert "You won" in text or "Solved" in text or "won" in text.lower(), text
    assert "Time" in text and "Hints" in text, text
    assert "Daily streak: 1 day" in text, text
    assert "Share" in text and "Close" in text, text
    got = pg.evaluate("""() => {
          const c = document.querySelector('.ar-sheet.gs-end .ar-sheet-card').getBoundingClientRect();
          const cells = [...document.querySelectorAll('.cw-grid *, #cw-grid *, [role=grid] *')].filter(e => !e.children.length && e.getBoundingClientRect().height);
          const bottom = Math.max.apply(null, cells.map(e => e.getBoundingClientRect().bottom));
          const time = [...document.querySelectorAll('.gs-chip')].map(c => c.textContent);
          return { top: c.top, bottom: c.bottom, h: window.innerHeight, grid: bottom, chips: time };
        }""")
    assert got["bottom"] > got["h"] - 40, got  # the sheet sits at the bottom
    assert (
        got["grid"] > 0 and got["grid"] <= got["top"] + 1
    ), got  # and the solved grid is above it, all of it
    assert any("0:0" in c or "0:" in c for c in got["chips"]), got
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "crossword-end.png"))
    assert not pg.errors, pg.errors


STAMP_PAGES = ["go.html", "sudoku.html", "chess.html", "minesweeper.html"]


@pytest.mark.parametrize("path", STAMP_PAGES)
def test_the_wins_stamp_lands_in_free_space_not_on_the_page(browser, site, path):
    pg = _page(browser, site, path)
    pg.wait_for_timeout(1500)
    pg.evaluate("() => ZimiShell.endSheet({ result: 'win', stats: [['Moves', '12']] })")
    pg.wait_for_selector(".gs-m-stamp", state="attached", timeout=5000)
    pg.wait_for_timeout(900)  # it has landed
    got = pg.evaluate("""() => {
          const s = document.querySelector('.gs-m-stamp').getBoundingClientRect();
          const hit = [...document.body.querySelectorAll('*')].filter((e) => {
            if (e.children.length || e.closest('.gs-moment, .ar-sheet, .gs-rest, .ar-bar, script, style')) return false;
            const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
            if (!r.width || !r.height || cs.position === 'fixed' || cs.visibility === 'hidden') return false;
            return r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top;
          }).map((e) => e.tagName + '.' + e.className);
          return { top: s.top, bottom: s.bottom, left: s.left, hit: hit.slice(0, 5), h: innerHeight };
        }""")
    assert not got["hit"], got
    assert got["bottom"] <= got["h"] and got["top"] >= 0, got
    if os.environ.get("SHOTS"):
        pg.screenshot(
            path=os.path.join(
                os.environ["SHOTS"], "stamp-" + path.replace(".html", "") + ".png"
            )
        )


def test_the_resting_bar_clears_the_corner_mark_inside_zimi(browser, site):
    pg = _page(browser, site, "sudoku.html")
    pg.wait_for_timeout(800)
    pg.evaluate("() => document.documentElement.classList.add('gs-hosted')")
    pg.evaluate(
        "() => ZimiShell.endSheet({ result: 'win', after: 0, stats: [['Moves', '12']] })"
    )
    pg.wait_for_selector(".ar-sheet.gs-end", timeout=5000)
    pg.click(".ar-sheet.gs-end >> text=Close")
    rest = pg.wait_for_selector(".gs-rest")
    box = rest.bounding_box()
    assert (
        box["y"] + box["height"] <= 844 - 32 + 1
    ), box  # above the mark's 20 px and its 12 px gap
