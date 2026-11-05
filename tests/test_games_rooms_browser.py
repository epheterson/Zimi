"""The shelf's one control line: the room, the types, one button for the view and the order.

Eric: "The top game pills area is so small. Can we make the compact and sort chooser things a little more compact instead
free up space? And that's actually two separate pill choosers side-by-side in that scrollable area that makes no sense."
The room is a single pill at the start of the line (its list of rooms lying over it), the scroller holds only the types,
and one small button at the end opens View and Order. One line at 360 and 390px, 44px targets, both views, light and
dark; a room filters the shelf and the Daily row, and every choice is kept. Daily: Five Letters and Sudoku lead.

Run: pytest tests/test_games_rooms_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_daily_browser import browser, site  # noqa: E402,F401

SHOTS = os.environ.get("ROOMS_SHOT_DIR")
VISIBLE = """() => [...new Set([...document.querySelectorAll('.sh-list a.ar-game')].filter(a => !a.hidden && !a.closest('section[hidden]')).map(a => a.getAttribute('href')))]"""
DAILY = """() => [...document.querySelectorAll('.ar-daily a.ar-game')].filter(a => !a.hidden).map(a => a.getAttribute('href').split('?')[0])"""
LINE = """() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height, w: b.width }; };
  return { pill: r('.sh-room-pick'), sel: r('.sh-room-sel'), nav: r('.sh-bar .sh-nav'), opt: r('.sh-opt'), roomChipsInNav: document.querySelectorAll('.sh-nav .sh-room, .sh-nav .sh-chip-sep').length, vw: innerWidth };
}"""


def _open(browser, site, view, width=390, scheme="light"):  # noqa: F811
    ctx = browser.new_context(viewport={"width": width, "height": 844}, color_scheme=scheme, device_scale_factor=2, has_touch=True, is_mobile=True)
    # Set once: a reload keeps what the page itself chose since.
    ctx.add_init_script("try{if(!sessionStorage.getItem('t-set')){sessionStorage.setItem('t-set','1');localStorage.setItem('zimi.games.view', %r)}}catch(e){}" % view)
    page = ctx.new_page()
    page.goto(site + "index.html")
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    return ctx, page


@pytest.mark.parametrize("width", [360, 390])
@pytest.mark.parametrize("view", ["lobby", "index"])
def test_one_line_room_types_and_one_options_button(site, browser, view, width):  # noqa: F811
    for scheme in ("light", "dark"):
        ctx, page = _open(browser, site, view, width, scheme)
        g = page.evaluate(LINE)
        assert g["roomChipsInNav"] == 0, "rooms still share the types' scroller"
        mid = lambda b: (b["top"] + b["bottom"]) / 2  # noqa: E731
        assert abs(mid(g["pill"]) - mid(g["nav"])) < 6 and abs(mid(g["opt"]) - mid(g["nav"])) < 6, g
        assert g["pill"]["right"] <= g["nav"]["left"] + 4 and g["nav"]["right"] <= g["opt"]["left"] + 4 and g["opt"]["right"] <= g["vw"], g
        assert g["sel"]["h"] >= 44 and g["opt"]["h"] >= 44 and g["opt"]["w"] >= 44, g
        assert g["nav"]["w"] >= width * 0.45, "the types' scroller is too narrow: %s" % g
        if SHOTS:
            page.screenshot(path=os.path.join(SHOTS, "line-%s-%d-%s.png" % (view, width, scheme)))
        ctx.close()


def test_the_options_button_sets_the_view_and_the_order_and_they_are_kept(site, browser):  # noqa: F811
    ctx, page = _open(browser, site, "lobby")
    page.click(".sh-opt")
    page.wait_for_selector(".ar-sheet:not([hidden]) .sh-opt-row")
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, "options-sheet.png"))
    page.locator(".ar-sheet:not([hidden]) .sh-opt-row").nth(0).locator(".ar-btn[aria-pressed=\"false\"]").click()
    page.wait_for_function("() => document.querySelector('.ar-shelf').dataset.view === 'index'")
    page.click(".sh-opt")
    page.locator(".ar-sheet:not([hidden]) .sh-opt-row").nth(1).locator(".ar-btn").nth(1).click()   # A to Z
    page.wait_for_function("() => document.querySelector('.ar-shelf').dataset.sort === 'az'")
    page.reload()
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    assert page.evaluate("() => [document.querySelector('.ar-shelf').dataset.view, document.querySelector('.ar-shelf').dataset.sort]") == ["index", "az"]
    ctx.close()


@pytest.mark.parametrize("view", ["lobby", "index"])
def test_a_room_filters_the_shelf_and_the_daily_row_and_is_kept(site, browser, view):  # noqa: F811
    ctx, page = _open(browser, site, view)
    assert page.inner_text(".sh-room-now") == "All"
    page.select_option(".sh-room-sel", "all")
    everything = page.evaluate(VISIBLE)
    page.select_option(".sh-room-sel", "kids")
    kids = page.evaluate(VISIBLE)
    assert kids and len(kids) < len(everything) and "memory.html" in kids and "chess.html" not in kids
    assert page.inner_text(".sh-room-now") == "Kids"
    if view == "lobby":
        daily = page.evaluate(DAILY)
        assert daily and set(daily) <= {"memory.html", "echo.html", "noughts.html", "snakesandladders.html", "fourinarow.html", "dotsandboxes.html", "crazyeights.html", "higherlower.html", "jigsaw.html", "ludo.html"}, daily
    page.reload()
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    assert page.inner_text(".sh-room-now") == "Kids", "the room was not kept"
    page.select_option(".sh-room-sel", "all")
    assert len(page.evaluate(VISIBLE)) == len(everything)
    ctx.close()


def test_five_letters_and_sudoku_lead_the_daily_row(site, browser):  # noqa: F811
    ctx, page = _open(browser, site, "lobby")
    assert page.evaluate(DAILY)[:2] == ["fiveletters.html", "sudoku.html"]
    ctx.close()
