"""Rooms on the real shelf: each one a place with its own light, kept in the address, rows filtered to it, and a game that carries it.

"world favorites and new doesn't seem to populate right always then reload fixes it". The cause: World favorites and Featured are
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

from test_games_daily_browser import GAMES, browser, site  # noqa: E402,F401

ROOMS = ("kids", "arcade", "night", "solo")
SHELF_PATHS = """() => [...new Set([...document.querySelectorAll('.sh-list a.ar-game')].filter(a => !a.hidden && !a.closest('section[hidden]')).map(a => a.getAttribute('href').split(/[?#]/)[0]))]"""
ROW = """(sel) => { const r = document.querySelector(sel); if (!r) return null;
  return { shown: getComputedStyle(r).display !== 'none', tiles: [...r.querySelectorAll('a.ar-game, a.ar-box')].filter(a => getComputedStyle(a).display !== 'none').map(a => a.getAttribute('href').split(/[?#]/)[0]) }; }"""
ROWS = (".ar-continue", ".ar-world", ".ar-featured", ".ar-daily")


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

    ctx = _context(browser, store="kids")
    page = _shelf(ctx, site)
    page.select_option(".sh-room-sel", "all")
    world, featured = page.evaluate(ROW, ".ar-world"), page.evaluate(ROW, ".ar-featured")
    assert world["shown"] and len(world["tiles"]) == 13, world
    assert featured["shown"] and len(featured["tiles"]) >= 3, featured
    assert not set(featured["tiles"]) & set(world["tiles"]), featured
    ctx.close()


@pytest.mark.parametrize("room", ROOMS)
def test_every_row_keeps_the_rooms_games_and_a_row_with_none_is_absent(
    site, browser, room
):  # noqa: F811
    ctx = _context(browser)
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


def test_featured_row_follows_the_room_and_never_shows_empty(site, browser):  # noqa: F811
    ctx = _context(browser)
    page = _shelf(ctx, site)
    assert page.evaluate(ROW, ".ar-featured")["shown"]
    for room in ROOMS:
        page.select_option(".sh-room-sel", room)
        page.wait_for_function(
            "(r) => document.querySelector('.ar-shelf').dataset.room === r", arg=room
        )
        row = page.evaluate(ROW, ".ar-featured")
        inside = set(page.evaluate(SHELF_PATHS))
        assert not row["shown"] or (row["tiles"] and set(row["tiles"]) <= inside), (room, row)
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
        # The ground fades between rooms; a slow frame can leave it part-way, the last room's colour still showing. Read it once it holds still.
        for _ in range(40):
            first = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
            page.wait_for_timeout(250)
            if first == page.evaluate("() => getComputedStyle(document.body).backgroundColor"):
                break
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


# Red: the shell chose it (zimi_app_theme in this origin's storage), so every game draws deep red on black from its tokens. A
# canvas or a picture may take the red filter; the chrome, the text, the boards and the cards never do.
RED_SCREENS = (
    ("index.html", "the shelf"),
    ("hearts.html", "a card game"),
    ("chess.html", "a board game"),
    ("letterbyletter.html", "a word game"),
    ("sudoku.html", "a logic puzzle"),
    ("zimcity.html", "ZimCity"),
)
NONRED_MIN = 110  # a green or blue component this far above black is a light that is not red
NONRED_SHARE_MAX = 0.002
RED_CONTRAST_FLOOR = 4.5
CONTRAST_JS = r"""(()=>{
const parse=c=>{const m=c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]]:[0,0,0,0]};
const over=(top,bot)=>{const a=top[3];return[top[0]*a+bot[0]*(1-a),top[1]*a+bot[1]*(1-a),top[2]*a+bot[2]*(1-a),1]};
const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};
const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const bgOf=e=>{const chain=[];for(let n=e;n&&n.nodeType===1;n=n.parentElement){const c=parse(getComputedStyle(n).backgroundColor);if(c[3]>0)chain.push(c);if(c[3]>=1)break}let bg=[0,0,0,1];for(let i=chain.length-1;i>=0;i--)bg=over(chain[i],bg);return bg};
const out=[];
document.querySelectorAll('body *').forEach(e=>{
 const own=[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());if(!own)return;
 const r=e.getBoundingClientRect();if(r.width<2||r.height<2||r.bottom<0||r.top>innerHeight)return;
 const s=getComputedStyle(e);if(s.visibility==='hidden'||s.display==='none')return;
 if(e.closest('[disabled],[aria-disabled="true"],[hidden]'))return;
 let op=1;for(let n=e;n&&n.nodeType===1;n=n.parentElement){op*=+getComputedStyle(n).opacity}
 if(op<0.99)return;
 const bg=bgOf(e),fg=over(parse(s.color),bg),cr=ratio(fg,bg);
 if(cr<4.5)out.push(cr.toFixed(2)+' "'+e.textContent.trim().slice(0,16)+'" '+e.tagName.toLowerCase()+'.'+(e.getAttribute('class')||'').split(' ')[0]+' '+s.color);
});
return out
})()"""


def _red_page(browser, site, path):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script("try{localStorage.setItem('zimi_app_theme','red')}catch(e){}")
    page = ctx.new_page()
    page.goto(site + path)
    page.wait_for_function("() => document.documentElement.classList.contains('night-red')")
    page.wait_for_timeout(1200)
    return ctx, page


def _nonred_share(page):
    import io

    from PIL import Image

    im = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
    px = im.load()
    bad = sum(1 for y in range(0, im.height, 2) for x in range(0, im.width, 2) if max(px[x, y][1], px[x, y][2]) > NONRED_MIN)
    return bad / ((im.height // 2) * (im.width // 2))


def test_red_is_a_real_theme_in_every_listed_screen(site, browser):  # noqa: F811
    """No light that is not red, body text at 4.5:1, and no filter over the page itself (only over pictures and canvases)."""
    for path, what in RED_SCREENS:
        ctx, page = _red_page(browser, site, path)
        assert page.evaluate("() => document.documentElement.dataset.theme") == "dark", what
        assert page.evaluate("() => getComputedStyle(document.documentElement).filter") == "none", what
        assert page.evaluate("() => getComputedStyle(document.body).filter") == "none", what
        share = _nonred_share(page)
        assert share <= NONRED_SHARE_MAX, "%s (%s): %.2f%% of the screen is not red" % (what, path, 100 * share)
        low = page.evaluate(CONTRAST_JS)
        assert not low, "%s (%s) has text under %.1f:1 in Red: %s" % (what, path, RED_CONTRAST_FLOOR, low)
        ctx.close()


def test_red_holds_in_a_games_menu_sheet(site, browser):  # noqa: F811
    ctx, page = _red_page(browser, site, "chess.html")
    page.click(".ar-bar button:has-text('Menu')")
    page.wait_for_selector(".ar-sheet:not([hidden])")
    page.wait_for_timeout(500)
    assert _nonred_share(page) <= NONRED_SHARE_MAX
    assert not page.evaluate(CONTRAST_JS)
    ctx.close()


def test_a_game_outside_zimi_stays_in_its_own_theme(site, browser):  # noqa: F811
    """In Kiwix there is no zimi_app_theme in the page's storage: the page keeps whatever theme it had."""
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme="light")
    page = ctx.new_page()
    page.goto(site + "chess.html")
    page.wait_for_timeout(500)
    assert not page.evaluate("() => document.documentElement.classList.contains('night-red')")
    assert page.evaluate("() => document.documentElement.dataset.theme") is None
    ctx.close()


def test_leaving_red_puts_back_what_the_page_had_pinned(site, browser):  # noqa: F811
    ctx, page = _red_page(browser, site, "chess.html")
    page.evaluate("() => { localStorage.removeItem('zimi_app_theme'); window.dispatchEvent(new StorageEvent('storage', { key: 'zimi_app_theme' })); }")
    page.wait_for_timeout(200)
    assert not page.evaluate("() => document.documentElement.classList.contains('night-red')")
    assert page.evaluate("() => document.documentElement.dataset.theme") is None
    ctx.close()


def test_every_game_on_the_shelf_is_red_in_red(site, browser, monkeypatch):  # noqa: F811
    """Walks games.json: a game cannot ship with light that is not red (a canvas or wasm puzzle may take the red filter)."""
    import json

    from test_games_daily_browser import _Handler

    # No /games-day answer: the fixed day the shared server gives has no UTC offset (Zimi's always has), so a word game
    # that opens "again on the server's day" would reload for ever against it, and never take Red.
    monkeypatch.setattr(_Handler, "day", None)
    with open(os.path.join(GAMES, "games.json"), encoding="utf-8") as f:
        paths = sorted({row["path"] for row in json.load(f)})
    assert len(paths) > 100
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script("try{localStorage.setItem('zimi_app_theme','red')}catch(e){}")
    worst = []
    for path in paths:
        page = ctx.new_page()
        page.goto(site + path, wait_until="domcontentloaded")
        try:
            page.wait_for_function("() => document.documentElement.classList.contains('night-red')", timeout=30000)
        except Exception:
            worst.append("%s never took Red" % path)
            page.close()
            continue
        page.wait_for_timeout(700)
        share = _nonred_share(page)
        if share > NONRED_SHARE_MAX:
            worst.append("%s %.2f%%" % (path, 100 * share))
        page.close()
    ctx.close()
    assert not worst, "light that is not red in Red: %s" % worst


# What each room does to the places that read the same in every room: the shelf's header, a sheet (Menu, the end of a game) and the
# win moment's confetti. A probe of each is put on the page, so the rules are read as the page would apply them.
LOOK = """() => {
  const html = document.documentElement, probe = (cls, tag) => { const e = document.createElement(tag || 'div'); e.className = cls; document.body.appendChild(e); return e; };
  const colour = (v) => { const e = probe(''); e.style.color = 'var(' + v + ')'; const c = getComputedStyle(e).color; e.remove(); return c; };
  const conf = [0, 1, 2].map(i => { const e = probe('gs-m-conf' + i); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; });
  const card = probe('ar-sheet-card'), cs = getComputedStyle(card), sheet = { border: cs.borderTopWidth + ' ' + cs.borderTopColor, shadow: cs.boxShadow }; card.remove();
  const h2 = (() => { const c = probe('ar-sheet-card'), t = document.createElement('h2'); c.appendChild(t); const s = getComputedStyle(t); const r = { color: s.color, family: s.fontFamily }; c.remove(); return r; })();
  return { accent: colour('--accent'), ink: colour('--ink'), line: colour('--line'), conf, sheet, h2 };
}"""
HEADER = """() => { const h = document.querySelector('.ar-shelf header'), b = document.querySelector('.ar-brand span'), hs = getComputedStyle(h), bs = getComputedStyle(b);
  return { rule: hs.borderBottomWidth + ' ' + hs.borderBottomColor, brandColor: bs.color, brandFamily: bs.fontFamily, brandWeight: bs.fontWeight, ink: getComputedStyle(document.body).color }; }"""
ROOM_GAMES = {"kids": "memory", "arcade": "snake", "night": "hearts", "solo": "sudoku"}
OLD_CONFETTI = ("rgb(239, 68, 68)", "rgb(245, 158, 11)", "rgb(249, 115, 22)")


@pytest.mark.parametrize("scheme", ["light", "dark"])
@pytest.mark.parametrize("room", ROOMS)
def test_each_room_colours_the_header_the_sheets_and_the_confetti(
    site, browser, room, scheme
):  # noqa: F811
    ctx = _context(browser, scheme=scheme)
    page = ctx.new_page()
    page.goto(site + ROOM_GAMES[room] + ".html#room=" + room)
    page.wait_for_function("() => document.documentElement.classList.contains('gs-ready')")
    got = page.evaluate(LOOK)
    # Confetti is the room's own: its accent first, never the fixed red, amber and orange.
    assert got["conf"][0] == got["accent"], got
    assert not set(got["conf"]) & set(OLD_CONFETTI), got
    assert len(set(got["conf"])) == 3, got
    # The sheet takes the room's edge.
    assert got["sheet"]["border"] != "1px " + got["line"] or room == "solo", got
    if room == "kids":
        assert got["sheet"]["border"] == "2px " + got["ink"], got   # a sticker: the tile's ink outline
    if room == "arcade":
        assert got["h2"]["color"] == got["accent"], got
    if room == "night":
        assert "serif" in got["h2"]["family"].lower() or "georgia" in got["h2"]["family"].lower(), got
    # The shelf's header carries it too.
    page.goto(site + "index.html#room=" + room)
    page.wait_for_selector(".ar-world a.ar-game", state="attached")
    head = page.evaluate(HEADER)
    assert head["rule"].startswith("2px ") if room == "kids" else head["rule"].startswith("1px "), head
    if room == "arcade":
        assert head["brandColor"] == got["accent"], head
    if room == "night":
        assert "serif" in head["brandFamily"].lower() or "georgia" in head["brandFamily"].lower(), head
    ctx.close()


def test_a_page_in_no_room_keeps_the_fixed_confetti_and_plain_sheet(site, browser):  # noqa: F811
    ctx = _context(browser)
    page = ctx.new_page()
    page.goto(site + "memory.html")
    page.wait_for_function("() => document.documentElement.classList.contains('gs-ready')")
    got = page.evaluate(LOOK)
    assert tuple(got["conf"]) == OLD_CONFETTI, got
    assert got["sheet"]["border"] == "1px " + got["line"], got
    ctx.close()
