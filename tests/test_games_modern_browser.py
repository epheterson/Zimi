"""Walls, Fourfold and Polyominoes played the way a person plays them on a phone: 390 by 844, touch, to the end of a game.

Each game is played by taps only (a scripted person against Zimi), the end sheet must come up, a position in the middle of a
game must survive leaving the page and coming back, and the board must open as an ARIA grid.

Run: pytest tests/test_games_modern_browser.py -v
"""

import functools
import http.server
import os
import threading

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
PHONE = {"width": 390, "height": 844}
TURN_MS = 60000  # the computer's reply, on a busy machine
SHEET = ".ar-sheet.gs-end:not([hidden])"


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
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # pragma: no cover
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


def open_game(browser, site, name, easy=True):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    if (
        easy
    ):  # the computer at its easiest, so the scripted person can finish a game quickly
        page.add_init_script(
            "localStorage.setItem('zimi.games.%s.settings', JSON.stringify({mode:'cpu', level:'easy', side:'first'}))"
            % name
        )
    page.goto(site + name + ".html?debug")
    page.wait_for_function(
        "() => document.querySelector('.ar-bar') && document.querySelector('[role=gridcell]')",
        timeout=15000,
    )
    return ctx, page, errors


def grid_shape(page, selector):
    return page.evaluate(
        """(sel) => { const g = document.querySelector(sel);
          const cells = [...g.querySelectorAll('[role=gridcell]')];
          return { role: g.getAttribute('role'), cells: cells.length, loose: cells.filter(c => c.parentElement.getAttribute('role') !== 'row').length,
                   stops: cells.filter(c => c.tabIndex === 0).length }; }""",
        selector,
    )


def wait_my_turn_or_end(page, expr_turn, timeout=TURN_MS):
    page.wait_for_function(
        "() => { try { return (%s) || !!document.querySelector('%s'); } catch (e) { return false; } }"
        % (expr_turn, SHEET),
        timeout=timeout,
    )


def ended(page):
    return page.locator(SHEET).count() > 0


# ── Walls ──
def test_walls_a_whole_game_by_touch(browser, site):
    ctx, page, errors = open_game(browser, site, "walls")
    try:
        shape = grid_shape(page, "#wl-board")
        assert (
            shape["role"] == "grid"
            and shape["cells"] == 81
            and shape["loose"] == 0
            and shape["stops"] == 1
        ), shape
        # lay one wall by touch: Wall, a point, Place
        page.tap("#wl-wallmode")
        page.tap('#wl-junc button[data-j="27"]')
        assert page.is_enabled("#wl-place")
        page.tap("#wl-turn")
        page.tap("#wl-place")
        wait_my_turn_or_end(page, "__walls.pos().turn === 0")
        assert (
            page.evaluate("__walls.pos().left[0]") == 9
        ), "the wall was laid and counted"
        # leave and come back in the middle of the game
        save = page.evaluate("ZimiGameSave()")
        assert save
        page.reload()
        page.wait_for_function("() => document.querySelector('[role=gridcell]')")
        assert page.evaluate("ZimiGameSave()") == save, "the position comes back"
        # then run for home: always the step that gets nearest the far edge
        for _ in range(80):
            if ended(page):
                break
            wait_my_turn_or_end(page, "__walls.pos().turn === 0")
            if ended(page):
                break
            best = page.evaluate(
                """() => { const E = __walls.engine, p = __walls.pos(); const steps = E.steps(p, 0);
                  steps.sort((a, b) => E.rowOf(a) - E.rowOf(b)); return steps[0]; }"""
            )
            page.tap('#wl-board button[data-s="%d"]' % best)
        page.wait_for_selector(SHEET, timeout=20000)
        assert not errors, errors
    finally:
        ctx.close()


# ── Fourfold ──
def test_fourfold_a_whole_game_by_touch(browser, site):
    ctx, page, errors = open_game(browser, site, "fourfold")
    try:
        shape = grid_shape(page, "#ff-board")
        assert (
            shape["role"] == "grid"
            and shape["cells"] == 16
            and shape["loose"] == 0
            and shape["stops"] == 1
        ), shape
        for turn in range(40):
            if ended(page):
                break
            wait_my_turn_or_end(
                page,
                "document.getElementById('ff-tray').querySelector('.ff-slot:not(.gone)[aria-disabled=false]') || document.querySelector('#ff-board .open')",
            )
            if ended(page):
                break
            if (
                page.evaluate("__fourfold.pos().given") >= 0
                and page.locator("#ff-board .pending").count() == 0
            ):
                cell = page.evaluate("[...__fourfold.pos().sq].findIndex(v => !v)")
                page.tap('#ff-board button[data-s="%d"]' % cell)
                if ended(page):
                    break
            safe = page.locator("#ff-tray .ff-slot:not(.gone):not(.danger)")
            (
                safe if safe.count() else page.locator("#ff-tray .ff-slot:not(.gone)")
            ).first.tap()
            page.tap("#ff-give")
            if turn == 2:  # leave and come back mid-game
                wait_my_turn_or_end(page, "__fourfold.pos().turn === 0")
                save = page.evaluate("ZimiGameSave()")
                page.reload()
                page.wait_for_function(
                    "() => document.querySelector('[role=gridcell]')"
                )
                assert (
                    page.evaluate("ZimiGameSave()") == save
                ), "the position comes back"
        page.wait_for_selector(SHEET, timeout=20000)
        assert not errors, errors
    finally:
        ctx.close()


# ── Polyominoes ──
def test_polyominoes_a_whole_game_by_touch(browser, site):
    ctx, page, errors = open_game(browser, site, "polyominoes")
    try:
        shape = grid_shape(page, "#po-board")
        assert (
            shape["role"] == "grid"
            and shape["cells"] == 196
            and shape["loose"] == 0
            and shape["stops"] == 1
        ), shape
        # tap a piece: its ghost is on the board at a legal spot, and Place is ready
        page.locator("#po-tray .po-slot:not(.gone):not(.stuck)").nth(9).tap()
        assert page.is_enabled("#po-place")
        page.tap("#po-rotate")
        page.tap("#po-flip")
        for turn in range(70):
            if ended(page):
                break
            wait_my_turn_or_end(
                page, "__poly.pos().turn === 0 && __poly.moves().length"
            )
            if ended(page):
                break
            if page.evaluate("__poly.moves()[0] === __poly.engine.PASS"):
                page.wait_for_function(
                    "() => __poly.pos().turn !== 0 || document.querySelector('%s')"
                    % SHEET,
                    timeout=10000,
                )
                continue
            # the biggest piece that can go: choose it, and the ghost is placed on a legal spot
            piece = page.evaluate(
                "Math.max(...__poly.moves().map(m => __poly.engine.pieceOf(m)))"
            )
            slot = page.locator('#po-tray .po-slot[data-p="%d"]' % piece)
            slot.tap()
            if page.is_enabled("#po-place"):
                page.tap("#po-place")
            if turn == 3:
                wait_my_turn_or_end(page, "__poly.pos().turn === 0")
                save = page.evaluate("ZimiGameSave()")
                page.reload()
                page.wait_for_function(
                    "() => document.querySelector('[role=gridcell]')"
                )
                assert (
                    page.evaluate("ZimiGameSave()") == save
                ), "the position comes back"
        page.wait_for_selector(SHEET, timeout=20000)
        assert not errors, errors
    finally:
        ctx.close()


def test_polyominoes_a_ghost_that_is_off_snaps_to_where_it_may_go(browser, site):
    ctx, page, errors = open_game(browser, site, "polyominoes")
    try:
        page.locator("#po-tray .po-slot:not(.gone):not(.stuck)").nth(
            5
        ).tap()  # the first piece must cover the start square
        box = page.evaluate(
            "(() => { const r = document.getElementById('po-board').getBoundingClientRect(); return [r.x, r.y, r.width / 14]; })()"
        )
        # touch a square one off from the legal place: it is lifted, shown, and let go it settles on a legal spot
        page.touchscreen.tap(box[0] + 5.5 * box[2], box[1] + 7 * box[2])
        assert page.is_enabled("#po-place"), "the ghost snapped to a legal place"
        page.tap("#po-place")
        page.wait_for_function("() => __poly.pos().placed[0] === 1")
        assert not errors, errors
    finally:
        ctx.close()
