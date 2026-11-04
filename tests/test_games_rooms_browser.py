"""Rooms on the shelf: the first chips of the one chip row (All, Kids, Arcade, Game night, Solo), a thin line, then the types.

Eric: "Should we do the start of rooms? Filtered view by like the vibes we listed but not yet themed?" Choosing a room
filters the shelf in both views and the Daily row, and is kept like the view and the order.

Run: pytest tests/test_games_rooms_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_daily_browser import PHONE, SERVER_DAY, browser, site  # noqa: E402,F401

SHOTS = os.environ.get("ROOMS_SHOT_DIR")
VISIBLE = """() => [...new Set([...document.querySelectorAll('.sh-list a.ar-game')].filter(a => !a.hidden && !a.closest('section[hidden]')).map(a => a.getAttribute('href')))]"""
DAILY = """() => [...document.querySelectorAll('.ar-daily a.ar-game')].filter(a => !a.hidden).map(a => a.getAttribute('href').split('?')[0])"""


@pytest.mark.parametrize("view", ["lobby", "index"])
def test_a_room_filters_the_shelf_and_the_daily_row_and_is_kept(site, browser, view):  # noqa: F811
    for scheme in ("light", "dark"):
        ctx = browser.new_context(viewport=PHONE, color_scheme=scheme, device_scale_factor=2)
        ctx.add_init_script("try{localStorage.setItem('zimi.games.view', %r)}catch(e){}" % view)
        page = ctx.new_page()
        page.goto(site + "index.html")
        page.wait_for_selector(".ar-daily a.ar-game")
        labels = page.eval_on_selector_all(".sh-nav > *", "els => els.slice(0, 6).map(e => e.className.includes('sh-chip-sep') ? '|' : e.firstChild.textContent)")
        assert labels == ["All", "Kids", "Arcade", "Game night", "Solo", "|"], labels
        page.click(".sh-room:has-text('All')")   # every game (Index opens on its first section)
        everything = page.evaluate(VISIBLE)
        page.click(".sh-room:has-text('Kids')")
        kids = page.evaluate(VISIBLE)
        assert kids and len(kids) < len(everything) and "memory.html" in kids and "chess.html" not in kids
        if view == "lobby":
            # The Daily row shows on All's feed; in a room it holds the room's dailies only.
            daily = page.evaluate(DAILY)
            assert daily and set(daily) <= {"memory.html", "echo.html", "noughts.html", "snakesandladders.html", "fourinarow.html", "dotsandboxes.html", "crazyeights.html", "higherlower.html", "jigsaw.html", "ludo.html"}, daily
        if SHOTS:
            page.screenshot(path=os.path.join(SHOTS, "rooms-%s-%s.png" % (view, scheme)))
        page.reload()
        page.wait_for_selector(".sh-room[aria-pressed='true']")
        assert page.inner_text(".sh-room[aria-pressed='true']").startswith("Kids"), "the room was not kept"
        page.click(".sh-room:has-text('All')")
        assert len(page.evaluate(VISIBLE)) == len(everything)
        ctx.close()
