"""Rooms on the real shelf: each one a place with its own light, kept in the address, rows filtered to it, and a game that carries it.

Eric: "world favorites and new doesn't seem to populate right always then reload fixes it". The cause: World favorites and New are
copies of the shelf's tiles, made once the shelf's data arrives; a copy of a tile the shelf had hidden for the room it opened in was
born hidden, so going to All showed a row of invisible games until a reload rebuilt it. The copies now answer for themselves and the
shelf filters every row for the room.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_rooms_theme_browser.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_daily_browser import browser, site  # noqa: E402,F401

ROOMS = ("kids", "arcade", "night", "solo")
SHELF_PATHS = """() => [...new Set([...document.querySelectorAll('.sh-list a.ar-game')].filter(a => !a.hidden && !a.closest('section[hidden]')).map(a => a.getAttribute('href').split(/[?#]/)[0]))]"""
ROW = """(sel) => { const r = document.querySelector(sel); if (!r) return null;
  return { shown: getComputedStyle(r).display !== 'none', tiles: [...r.querySelectorAll('a.ar-game, a.ar-box')].filter(a => getComputedStyle(a).display !== 'none').map(a => a.getAttribute('href').split(/[?#]/)[0]) }; }"""
ROWS = (".ar-continue", ".ar-world", ".ar-new", ".ar-daily")


def _context(browser, scheme="light", width=390, store=None):  # noqa: F811
    ctx = browser.new_context(
        viewport={"width": width, "height": 844},
        color_scheme=scheme,
        has_touch=width < 700,
        is_mobile=width < 700,
    )
    if store:
        # Set once: a reload keeps what the page itself chose since.
        ctx.add_init_script(
            "try{if(!sessionStorage.getItem('t-set')){sessionStorage.setItem('t-set','1');localStorage.setItem('zimi.games.room', %r)}}catch(e){}"
            % store
        )
    return ctx


def _shelf(ctx, site, hash_=""):  # noqa: F811
    page = ctx.new_page()
    page.goto(site + "index.html" + hash_)
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    page.wait_for_function(
        "() => document.querySelector('.ar-world') && document.querySelector('.ar-world a.ar-game')"
    )
    return page


def test_world_favorites_and_new_are_there_after_leaving_a_room(
    site, browser
):  # noqa: F811
    """The reported bug. Open in Kids (kept from last time), go to All: every tile of both rows shows, no reload."""

    def routed(route):
        rows = json.loads(route.fetch().text())
        for r in rows:
            if r["path"] in ("memory.html", "chess.html", "snake.html"):
                r["added"] = "1.99"
        route.fulfill(content_type="application/json", body=json.dumps(rows))

    ctx = _context(browser, store="kids")
    ctx.route("**/games.json", routed)
    page = _shelf(ctx, site)
    page.select_option(".sh-room-sel", "all")
    world, new = page.evaluate(ROW, ".ar-world"), page.evaluate(ROW, ".ar-new")
    assert world["shown"] and len(world["tiles"]) == 13, world
    assert new["shown"] and sorted(new["tiles"]) == [
        "chess.html",
        "memory.html",
        "snake.html",
    ], new
    ctx.close()


@pytest.mark.parametrize("room", ROOMS)
def test_every_row_keeps_the_rooms_games_and_a_row_with_none_is_absent(
    site, browser, room
):  # noqa: F811
    def routed(route):
        rows = json.loads(route.fetch().text())
        for r in rows:
            if r["path"] in ("memory.html", "chess.html", "hearts.html", "sudoku.html"):
                r["added"] = "1.99"
        route.fulfill(content_type="application/json", body=json.dumps(rows))

    ctx = _context(browser)
    ctx.route("**/games.json", routed)
    page = _shelf(ctx, site)
    page.select_option(".sh-room-sel", room)
    page.wait_for_function(
        "(r) => document.querySelector('.ar-shelf').dataset.room === r", arg=room
    )
    inside = set(page.evaluate(SHELF_PATHS))
    assert inside
    shown = 0
    for sel in ROWS:
        row = page.evaluate(ROW, sel)
        if row is None:
            continue
        if row["shown"]:
            shown += 1
            assert row["tiles"], "%s is on show with nothing in it" % sel
            assert set(row["tiles"]) <= inside, (sel, set(row["tiles"]) - inside)
    world = page.evaluate(ROW, ".ar-world")
    assert (
        world and world["shown"] and len(world["tiles"]) >= 6
    ), "no World favorites in %s: %s" % (room, world)
    assert shown >= 2
    ctx.close()


def test_a_room_with_no_new_game_has_no_new_row(site, browser):  # noqa: F811
    def routed(route):
        rows = json.loads(route.fetch().text())
        for r in rows:
            if r["path"] in ("chess.html", "hearts.html"):
                r["added"] = "1.99"
        route.fulfill(content_type="application/json", body=json.dumps(rows))

    ctx = _context(browser)
    ctx.route("**/games.json", routed)
    page = _shelf(ctx, site)
    assert page.evaluate(ROW, ".ar-new")["shown"]
    page.select_option(".sh-room-sel", "arcade")
    assert not page.evaluate(ROW, ".ar-new")[
        "shown"
    ], "an empty New row is on show in Arcade"
    page.select_option(".sh-room-sel", "night")
    assert page.evaluate(ROW, ".ar-new")["tiles"] == ["hearts.html"]
    ctx.close()


def test_the_room_is_in_the_address_and_back_from_a_game_returns_to_it(
    site, browser
):  # noqa: F811
    ctx = _context(browser)
    page = _shelf(ctx, site)
    page.select_option(".sh-room-sel", "night")
    assert page.evaluate("() => location.hash") == "#room=night"
    page.locator(".sh-list a.ar-game[href='hearts.html']").first.click()
    page.wait_for_url("**/hearts.html#room=night")
    assert page.evaluate("() => document.documentElement.dataset.room") == "night"
    assert (
        page.evaluate("() => document.querySelector('.ar-back').getAttribute('href')")
        == "index.html#room=night"
    )
    page.go_back()
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    assert (
        page.inner_text(".sh-room-now") == "Game night"
        and page.evaluate("() => document.documentElement.dataset.room") == "night"
    )
    # The game's own Back does the same, and a bookmark of the address opens in the room even where nothing was kept.
    page.locator(".sh-list a.ar-game[href^='hearts.html']").first.click()
    page.wait_for_selector(".ar-back")
    page.click(".ar-back")
    page.wait_for_selector(".ar-daily a.ar-game", state="attached")
    assert page.inner_text(".sh-room-now") == "Game night"
    other = _context(browser)
    fresh = _shelf(other, site, "#room=solo")
    assert fresh.inner_text(".sh-room-now") == "Solo"
    ctx.close()
    other.close()


def test_all_leaves_no_trace_in_the_address_or_the_page(site, browser):  # noqa: F811
    ctx = _context(browser, store="kids")
    page = _shelf(ctx, site)
    page.select_option(".sh-room-sel", "all")
    assert page.evaluate("() => location.hash") == ""
    assert (
        page.evaluate("() => document.documentElement.hasAttribute('data-room')")
        is False
    )
    ctx.close()


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_a_room_changes_the_light_by_its_own_tokens(
    site, browser, scheme
):  # noqa: F811
    ctx = _context(browser, scheme)
    page = _shelf(ctx, site)
    rooms = {r["id"]: r for r in page.evaluate("() => ZimiShell.rooms")}
    neutral = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    seen = {neutral}
    for room in ROOMS:
        page.select_option(".sh-room-sel", room)
        page.wait_for_timeout(500)
        want = rooms[room]["tokens"][scheme]
        got = page.evaluate(
            "() => { const s = getComputedStyle(document.documentElement); return { ground: s.getPropertyValue('--ground').trim(), accent: s.getPropertyValue('--accent').trim(), bg: getComputedStyle(document.body).backgroundColor }; }"
        )
        assert (got["ground"], got["accent"]) == (want["ground"], want["accent"]), (
            room,
            scheme,
            got,
        )
        assert got["bg"] not in seen, "%s looks like another room" % room
        seen.add(got["bg"])
    ctx.close()


def test_a_game_takes_the_rooms_bar_and_card_table_and_keeps_its_own_materials(
    site, browser
):  # noqa: F811
    ctx = _context(browser, "dark")
    page = ctx.new_page()
    page.goto(site + "hearts.html#room=night")
    page.wait_for_selector(".zc-table")
    tokens = page.evaluate(
        "() => ZimiShell.rooms.find(r => r.id === 'night').tokens.dark"
    )

    def rgb(h):
        return "rgb(%d, %d, %d)" % tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))

    assert page.evaluate(
        "() => getComputedStyle(document.querySelector('.ar-bar')).backgroundColor"
    ) == rgb(tokens["surface"])
    assert (
        page.evaluate(
            "() => getComputedStyle(document.querySelector('.zc-table')).backgroundImage"
        ).count(rgb(tokens["table"]))
        == 1
    )
    # A board that is its own material keeps it: Chess's wood does not follow the room.
    page.goto(site + "chess.html#room=night")
    page.wait_for_selector(".ar-bar")
    wood = page.evaluate(
        "() => getComputedStyle(document.documentElement).getPropertyValue('--wood').trim()"
    )
    assert wood == "#4a3524", (
        "a room changed the shared wood a board is made of: %s" % wood
    )
    ctx.close()


def test_a_room_is_entered_over_a_beat_and_not_at_all_when_motion_is_off(
    site, browser
):  # noqa: F811
    ctx = _context(browser)
    page = _shelf(ctx, site)
    page.select_option(".sh-room-sel", "arcade")
    assert page.evaluate(
        "() => document.documentElement.classList.contains('gs-room-fade')"
    )
    assert (
        page.evaluate(
            "() => getComputedStyle(document.querySelector('.ar-game')).transitionDuration"
        )
        .startswith("0.36s")
    )
    page.wait_for_function(
        "() => !document.documentElement.classList.contains('gs-room-fade')",
        timeout=2000,
    )
    ctx.close()
    calm = browser.new_context(
        viewport={"width": 390, "height": 844}, reduced_motion="reduce"
    )
    page = _shelf(calm, site)
    page.select_option(".sh-room-sel", "arcade")
    assert (
        float(
            page.evaluate(
                "() => getComputedStyle(document.querySelector('.ar-game')).transitionDuration"
            ).rstrip("s")
        )
        < 0.01
    )
    calm.close()


def test_rooms_ask_nothing_of_a_server(site, browser):  # noqa: F811
    """The shelf must work in stock kiwix-serve: moving between rooms fetches no new file, and no address that only Zimi answers."""
    ctx = _context(browser)
    page = _shelf(ctx, site)
    before = set()
    page.on("request", lambda r: before.add(r.url))
    for room in ROOMS + ("all",):
        page.select_option(".sh-room-sel", room)
        page.wait_for_timeout(150)
    assert all("/thumbs/" in u for u in before), "a room fetched: %s" % sorted(before)   # a tile coming into view loads its own picture, as it always did
    ctx.close()
