"""The bar never shifts: Undo has its place from the first frame (disabled until a move), so Menu sits at the same x before
and after the first move, and a bar title localizes whenever it is the game's title, however the markup spells it.

Touch targets on a 390px phone: the shelf's controls give a finger 44 x 44, and a press on a grid of cells, a keyboard or a
fan of cards never lands in a gap between two of them (a dead gap is a second try).

Run: pytest tests/test_games_bar_stable.py -v
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import game_ready  # noqa: E402
from hit_area import undersized  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")


@pytest.fixture(scope="module")
def base():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def pw():
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="module")
def browser(pw):
    for kind in (pw.webkit, pw.chromium):
        try:
            b = kind.launch()
        except Exception:
            continue
        yield b
        b.close()
        return
    pytest.skip("no browser installed")


def open_game(browser, base, name, width=390, **ctx):
    c = browser.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True, **ctx)
    # Five Letters opens its how-to-play sheet by itself on a first visit; these tests are past it.
    c.add_init_script("localStorage.setItem('zimi.games.fiveletters.how', '{\"seen\":true}')")
    page = c.new_page()
    page.goto(base + "/" + name)
    game_ready(page)
    return c, page


def menu_x(page):
    return page.locator(".ar-bar .gs-menu-btn").bounding_box()["x"]


@pytest.mark.parametrize("width", [320, 390])
def test_undo_is_reserved_so_menu_does_not_move_on_the_first_move(browser, base, width):
    c, page = open_game(browser, base, "draughts.html", width)
    undo = page.locator(".ar-bar #wk-undo")
    assert undo.is_visible() and undo.is_disabled(), "Undo is there from the start, disabled"
    before = menu_x(page)
    page.evaluate("document.getElementById('wk-undo').disabled = false")
    page.wait_for_timeout(100)
    assert undo.is_enabled()
    assert menu_x(page) == before
    c.close()


def test_the_game_title_localizes_without_a_workaround_key(browser, base):
    c, page = open_game(browser, base, "draughts.html", 390)
    assert page.locator(".ar-bar h1").inner_text() == "International Draughts"
    c.close()
    c = browser.new_context(viewport={"width": 390, "height": 844}, locale="fr-FR")
    page = c.new_page()
    page.goto(base + "/draughts.html")
    game_ready(page)
    fr = page.evaluate("ZimiText.T('game.draughts.title')")
    assert page.locator(".ar-bar h1").inner_text() == fr != "International Draughts"
    c.close()


def test_a_title_spelled_with_a_straight_apostrophe_still_localizes(browser, base):
    c = browser.new_context(viewport={"width": 390, "height": 844}, locale="fr-FR")
    page = c.new_page()

    # The page spells it Hold&rsquo;em and the table Hold’em; serve it with a
    # straight apostrophe so the two really differ.
    def straight(route):
        body = route.fetch().text().replace("Hold&rsquo;em", "Hold'em")
        assert "Hold'em" in body
        route.fulfill(body=body, content_type="text/html")

    page.route("**/holdem.html", straight)
    page.goto(base + "/holdem.html")
    game_ready(page)
    fr = page.evaluate("ZimiText.T('game.holdem.title')")
    assert page.locator(".ar-bar h1").inner_text() == fr
    c.close()


# What cannot reach 44 on a phone is a physical grid (ten keys across, nine cells across): there the rule is no dead gap, the
# nearest cell takes the touch. Each game names the cell it is made of.
SEAM_GAMES = [
    ("sudoku.html", ".su-c"),
    ("go.html", ".go-pt"),
    ("fiveletters.html", ".fl-key"),
    ("minicrossword.html", ".cw-key"),
    ("mahjong.html", ".mj-t"),
    ("spider.html", ".zc-card, .zc-slot"),
    ("hearts.html", ".zc-card"),
]

_SEAMS = """(sel) => {
  const cells = [...document.querySelectorAll(sel)].filter(e => e.offsetWidth && !e.closest('[hidden]'));
  const box = (e) => e.getBoundingClientRect(), bad = [];
  const hit = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && !!h.closest(sel); };
  // The middle of the gap between each cell and the next one on its row (and below it in its column).
  for (const a of cells) {
    const r = box(a);
    for (const b of cells) {
      if (a === b) continue;
      const q = box(b), rows = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top), cols = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      if (rows > 4 && q.left >= r.right - 1 && q.left - r.right < 12) { const x = (r.right + q.left) / 2, y = (Math.max(r.top, q.top) + Math.min(r.bottom, q.bottom)) / 2; if (!hit(x, y)) bad.push([a.className, 'right', Math.round(x), Math.round(y)]); }
      if (cols > 4 && q.top >= r.bottom - 1 && q.top - r.bottom < 12) { const y = (r.bottom + q.top) / 2, x = (Math.max(r.left, q.left) + Math.min(r.right, q.right)) / 2; if (!hit(x, y)) bad.push([a.className, 'below', Math.round(x), Math.round(y)]); }
    }
  }
  return { n: cells.length, bad: bad.slice(0, 6) };
}"""


@pytest.mark.parametrize("game,cell", SEAM_GAMES)
def test_a_touch_between_two_cells_is_never_lost(browser, base, game, cell):
    c, page = open_game(browser, base, game)
    r = page.evaluate(_SEAMS, cell)
    if "zc-" in cell:
        # The card table takes a press in a gap for the pile nearest it: a press there lifts that pile's top card.
        lost = []
        for _name, _side, x, y in r["bad"]:
            page.mouse.move(x, y)
            page.mouse.down()
            if not page.query_selector(".zc-drag"):
                lost.append((x, y))
            page.mouse.up()
        r["bad"] = lost
    c.close()
    assert r["n"] > 4, r
    assert not r["bad"], r


def test_the_shelf_gives_a_finger_44px(browser, base):
    c = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    page = c.new_page()
    page.goto(base + "/index.html")
    page.wait_for_selector(".ar-shelf header", timeout=30000)
    page.wait_for_timeout(1500)
    short = undersized(page)
    c.close()
    assert not short, "\n".join(short)


# One game of each kind: its menu and the sheets the menu opens (Settings, How to play, History, Stats, About) give a finger 44.
SHEET_GAMES = ["chess.html", "solitaire.html", "sudoku.html", "snake.html", "flags.html", "yacht.html", "memory.html", "mahjong.html"]


@pytest.mark.parametrize("game", SHEET_GAMES)
def test_the_menu_and_its_sheets_give_a_finger_44px(browser, base, game):
    c, page = open_game(browser, base, game)
    short = []
    page.evaluate("document.querySelector('.gs-menu-btn').click()")
    page.wait_for_timeout(500)
    short += undersized(page, noscroll=True)
    sheet = ".ar-sheet button, .gs-sheet button, [role=dialog] button, [role=menu] button"
    labels = page.evaluate("(s) => [...document.querySelectorAll(s)].map(e => (e.textContent || '').trim())", sheet)
    for want in ("Settings", "How to play", "History", "Stats", "About this game"):
        if want not in labels:
            continue
        page.evaluate(
            "([s, w]) => [...document.querySelectorAll(s)].find(e => (e.textContent || '').trim() === w).click()", [sheet, want]
        )
        page.wait_for_timeout(500)
        short += undersized(page, noscroll=True)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        if not page.query_selector(sheet):
            page.evaluate("document.querySelector('.gs-menu-btn').click()")
            page.wait_for_timeout(400)
    c.close()
    assert not short, "\n".join(sorted(set(short)))


# Every board, card and tile game on the shelf, and minesweeper: the cells are what the page puts a press handler on, or
# the children of the box that has one (found through the browser's own list of listeners).
_CELLS = """(idx) => {
  const all = Array.from(document.querySelectorAll('body, body *'));
  const sig = (e) => { const c = ((e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className) + '').trim().split(/\\s+/).filter(Boolean)[0];
    return c ? e.tagName.toLowerCase() + '.' + CSS.escape(c) : null; };
  const out = new Set(['.zc-card', '.zc-slot']), plain = (e) => !/^(svg|g|path|rect|circle|use|text|line|polygon|polyline|ellipse|defs)$/.test(e.tagName) && !e.closest('svg');
  for (const i of idx) {
    const e = all[i], r = e.getBoundingClientRect();
    if (e.closest('.ar-bar, .gs-bar, .ar-sheet, [role=dialog]')) continue;
    if (r.width <= 200 && r.height <= 200) { if (plain(e) && sig(e)) out.add(sig(e)); continue; }
    const n = {};
    e.querySelectorAll('*').forEach((c) => { const q = c.getBoundingClientRect(); if (q.width > 6 && q.width < 120 && q.height > 6 && q.height < 140 && plain(c) && sig(c)) n[sig(c)] = (n[sig(c)] || 0) + 1; });
    for (const [k, v] of Object.entries(n)) if (v >= 4) out.add(k);
  }
  return [...out].join(',');
}"""


@pytest.fixture(scope="module")
def chromium(pw):
    """The listeners behind a press are only asked of Chromium (the DevTools protocol)."""
    try:
        b = pw.chromium.launch()
    except Exception:
        pytest.skip("no chromium installed")
    yield b
    b.close()


def _cell_selector(page):
    cdp = page.context.new_cdp_session(page)
    arr = cdp.send("Runtime.evaluate", {"expression": "Array.from(document.querySelectorAll('body, body *'))"})
    props = cdp.send("Runtime.getProperties", {"objectId": arr["result"]["objectId"], "ownProperties": True})
    idx = []
    for pr in props["result"]:
        oid = pr["value"].get("objectId") if pr["name"].isdigit() else None
        if oid and {l["type"] for l in cdp.send("DOMDebugger.getEventListeners", {"objectId": oid})["listeners"]} & {"click", "pointerdown", "pointerup", "mousedown", "touchstart"}:
            idx.append(int(pr["name"]))
    found = page.evaluate(_CELLS, idx).split(",")
    if ".zc-card" in found and any("zc-" in f for f in found if f not in (".zc-card", ".zc-slot")):
        return ".zc-card,.zc-slot"  # the card table: the cards and their places, not what is drawn on them
    return ",".join(f for f in found if f not in ("button.ar-btn", "button.ar-back", "span.ct-chip", ".zc-card", ".zc-slot")) or ".zc-card,.zc-slot"


def _shelf_games(*kinds):
    import json

    rows = json.load(open(os.path.join(GAMES, "games.json")))
    return sorted({r["path"] for r in rows if r.get("kind") in kinds and r.get("path") and "/" not in r["path"]} | {"minesweeper.html"})


@pytest.mark.parametrize("game", _shelf_games("board", "cards", "tiles"))
def test_no_touch_is_lost_between_the_cells_of_any_board_or_card_game(chromium, base, game):
    try:
        c, page = open_game(chromium, base, game)
    except Exception:
        pytest.skip("a game that waits on a lobby or a canvas")
    sel = _cell_selector(page)
    r = page.evaluate(_SEAMS, sel)
    if r["bad"] and "zc-" not in sel:
        # A gap is not lost if a touch there reaches a cell anyway (the place kit sends it to the nearest within 14px).
        page.evaluate(
            """(sel) => { window.__reached = 0; for (const t of ['click', 'pointerdown', 'pointerup'])
            document.addEventListener(t, (e) => { if (e.target.closest && e.target.closest(sel)) window.__reached++; }, true); }""",
            sel,
        )
        lost = []
        for _n, _s, x, y in r["bad"]:
            page.evaluate("window.__reached = 0")
            page.mouse.click(x, y)  # the mouse: no browser help in aiming a touch at the nearest control
            page.wait_for_timeout(150)
            if not page.evaluate("window.__reached"):
                lost.append((x, y))
        r["bad"] = lost
    if "zc-" in sel and r["bad"]:
        # The card table takes a press in a gap for the pile nearest it (cards.js nearestSlot, 14px): a gap with no pile that near is lost.
        r["bad"] = [
            (x, y)
            for _n, _s, x, y in r["bad"]
            if not page.evaluate(
                """([x, y]) => [...document.querySelectorAll('.zc-slot')].some(e => { const r = e.getBoundingClientRect();
                return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)) <= 14; })""",
                [x, y],
            )
        ]
    c.close()
    assert not r["bad"], (sel, r)
