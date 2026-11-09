"""A daily is the same game for everyone on one Zimi, whatever the device's clock or time zone.

Eric: "Daily must be same for all users of the Zimi server right". The shelf asks the server for its day (/games-day) and
writes it into every Daily tile's address; the game takes its seed from that date and its page alone. Two phones in
Honolulu and Auckland, a day apart on their own clocks, open the same daily and see the same board. Off Zimi (no
/games-day) the device's own day is used.

Run: pytest tests/test_games_daily_browser.py -v
"""

import functools
import http.server
import json
import os
import threading

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
SERVER_DAY = "2026-11-04"
ZONES = (
    "Pacific/Honolulu",
    "Pacific/Auckland",
)  # 23 hours apart: on most of the day, two different calendar days
PHONE = {"width": 390, "height": 844}
SETTLE_MS = 2500  # a deal's cards fly in; Spider's 104 take the longest


class _Handler(http.server.SimpleHTTPRequestHandler):
    """The games folder, as Zimi serves it, with the server's day at /games-day when the test asks for one."""

    day = SERVER_DAY

    def do_GET(self):
        if self.path.split("?")[0] == "/games-day":
            if not self.day:
                self.send_error(404)
                return
            body = json.dumps({"day": self.day}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a, **k):
        pass


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(_Handler, directory=GAMES)
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


def _phone(browser, zone):
    return browser.new_context(viewport=PHONE, timezone_id=zone, locale="en-US")


def _daily_hrefs(ctx, site):
    page = ctx.new_page()
    page.goto(site + "index.html")
    page.wait_for_selector(".ar-daily a.ar-game")
    # Every tile with a daily (Game of the day leads the row; it is a daily only when its game has one).
    hrefs = page.eval_on_selector_all(
        ".ar-daily a.ar-game:not(.ar-feature), .ar-daily a.ar-feature[href*='?daily=']", "els => els.map(e => e.getAttribute('href'))"
    )
    page.close()
    return hrefs



def _shot(page, name):
    """A picture for a person to look at, only when DAILY_SHOT_DIR asks for one (no stray files in /tmp, which Windows lacks)."""
    if os.environ.get("DAILY_SHOT_DIR"):
        page.screenshot(path=os.path.join(os.environ["DAILY_SHOT_DIR"], name))


def test_the_shelf_writes_the_servers_day_into_every_daily_whatever_the_zone(
    site, browser
):
    seen = []
    for zone in ZONES:
        ctx = _phone(browser, zone)
        seen.append(_daily_hrefs(ctx, site))
        ctx.close()
    assert seen[0] and seen[0] == seen[1]
    assert all(h.endswith("?daily=" + SERVER_DAY) for h in seen[0])
    assert (
        "sudoku.html?daily=" + SERVER_DAY in seen[0]
        and "puzzles/loopy.html?daily=" + SERVER_DAY in seen[0]
    )


# The tableau solitaires after Klondike: each deals from the day's seed like Klondike and FreeCell.
VARIANT_DAILIES = (
    "yukon",
    "fortythieves",
    "canfield",
    "scorpion",
    "acesup",
    "accordion",
    "calculation",
    "beleaguered",
    "eightoff",
    "montecarlo",
)
SUDOKU = "() => document.getElementById('su-board').innerText"
# Cards stacked in one place (Calculation's face-down deck) keep their pile order: the deal shows in that order, not in the ids.
CARDS = """() => Array.from(document.querySelectorAll('.zc-card[data-id]')).map(e => {
  const r = e.getBoundingClientRect();
  return { id: +e.dataset.id, col: Math.round(r.left / 20), top: r.top, down: e.classList.contains('zc-down') };
}).sort((a, b) => a.col - b.col || a.top - b.top).map(c => [c.id, c.col, c.down])"""
TATHAM = """() => { const cw = Module.cwrap; const p = cw('get_save_file','number',[])(); const t = UTF8ToString(p);
  cw('free_save_file','void',['number'])(p); return (/^DESC\\s*:\\d+:(.*)$/m.exec(t) || [])[1]; }"""


@pytest.mark.parametrize(
    "path, ready, board",
    [
        (
            "sudoku.html",
            "document.getElementById('su-board').innerText.trim().length > 20",
            SUDOKU,
        ),
        (
            "solitaire.html",
            "document.querySelectorAll('.zc-card[data-id]').length === 52",
            CARDS,
        ),
        (
            "spider.html",
            "document.querySelectorAll('.zc-card[data-id]').length === 104",
            CARDS,
        ),
    ]
    + [
        (
            name + ".html",
            "document.querySelectorAll('.zc-card[data-id]').length >= 20",
            CARDS,
        )
        for name in VARIANT_DAILIES
    ]
    + [
        (
            "puzzles/loopy.html",
            "typeof command === 'function' && document.getElementById('puzzle').style.display !== 'none'",
            TATHAM,
        ),
    ],
)
def test_two_phones_a_day_apart_on_their_clocks_get_the_same_daily(
    site, browser, path, ready, board
):
    boards = []
    for zone in ZONES:
        ctx = _phone(browser, zone)
        page = ctx.new_page()
        page.goto(site + path + "?daily=" + SERVER_DAY)
        page.wait_for_function(ready, timeout=20000)
        page.wait_for_timeout(SETTLE_MS)  # the deal's animation settles
        boards.append(page.evaluate(board))
        ctx.close()
    assert boards[0] and boards[0] == boards[1]
    # And it is the day's game, not just any game twice: an ordinary game of the same page is another deal.
    ctx = _phone(browser, ZONES[0])
    page = ctx.new_page()
    page.goto(site + path)
    page.wait_for_function(ready, timeout=20000)
    page.wait_for_timeout(SETTLE_MS)
    assert page.evaluate(board) != boards[0]
    ctx.close()


def test_off_zimi_the_devices_own_day_is_the_daily(site, browser):
    _Handler.day = None
    try:
        ctx = browser.new_context(viewport=PHONE, timezone_id=ZONES[1])
        page = ctx.new_page()
        page.goto(site + "index.html")
        page.wait_for_selector(".ar-daily a.ar-game")
        device_day = page.evaluate(
            "() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }"
        )
        href = page.get_attribute(".ar-daily a.ar-game:not(.ar-feature)", "href")
        assert href.endswith("?daily=" + device_day)
        ctx.close()
    finally:
        _Handler.day = SERVER_DAY


def test_a_finished_daily_is_ticked_on_the_shelf_and_its_end_sheet_shares_no_answer(
    site, browser
):
    ctx = _phone(browser, ZONES[0])
    page = ctx.new_page()
    page.goto(site + "sudoku.html?daily=" + SERVER_DAY)
    page.wait_for_function(
        "document.getElementById('su-board').innerText.trim().length > 20",
        timeout=20000,
    )
    page.mouse.click(195, 400)  # the player touched the game: its end counts
    page.evaluate(
        "() => ZimiShell.endSheet({ result: 'win', after: 0, stats: [['Time', '4:12']] })"
    )
    page.wait_for_selector(".gs-share-row button")
    _shot(page, "daily-end-sheet.png")
    kept = page.evaluate("() => JSON.parse(localStorage.getItem('zimi.games.stats'))")
    assert kept["days"][SERVER_DAY] == {"sudoku.html": "win"}
    text = page.evaluate(
        "() => { let t = ''; navigator.clipboard.writeText = s => { t = s; return Promise.resolve(); }; document.querySelector('.gs-share-row button').click(); return t; }"
    )
    assert SERVER_DAY in text and "Sudoku" in text and "4:12" in text
    solution_digits = page.evaluate(
        "() => (window.__su && window.__su.solution || []).join('')"
    )
    assert not solution_digits or solution_digits not in text.replace("\n", "")
    page.goto(site + "index.html")
    page.wait_for_selector(".ar-daily a.ar-game")
    done = page.eval_on_selector_all(
        ".ar-daily a.ar-done", "els => els.map(e => e.getAttribute('href'))"
    )
    assert done == ["sudoku.html?daily=" + SERVER_DAY]
    assert "Done today: 1" in page.inner_text(".ar-daily-line")
    _shot(page, "daily-shelf.png")
    ctx.close()


NSTATES = TATHAM.replace("DESC", "NSTATES")


def test_a_solved_tatham_daily_comes_back_solved(site, browser):
    ctx = _phone(browser, ZONES[0])
    page = ctx.new_page()
    url = site + "puzzles/net.html?daily=" + SERVER_DAY   # a puzzle that keeps its status bar, where COMPLETED shows
    page.goto(url)
    page.wait_for_function("typeof command === 'function' && document.getElementById('puzzle').style.display !== 'none'", timeout=20000)
    fresh = page.evaluate(NSTATES)
    page.evaluate("() => document.getElementById('solve').click()")
    page.wait_for_timeout(500)
    if page.locator(".ar-sheet:not([hidden]) .gs-primary").count():
        page.locator(".ar-sheet:not([hidden]) .gs-primary").first.click()
    page.wait_for_function("f => (%s)() !== f" % NSTATES, arg=fresh, timeout=10000)
    # The puzzle says COMPLETED when the player solves it; the solver does not, so the test says it for the player.
    page.evaluate("() => { document.getElementById('statusbar').textContent = 'COMPLETED!'; }")
    page.wait_for_timeout(300)
    page.evaluate("() => ZimiShell.saveNow()")
    solved = page.evaluate(NSTATES)
    assert solved != fresh
    page.goto(url)
    page.wait_for_function("typeof command === 'function' && document.getElementById('puzzle').style.display !== 'none'", timeout=20000)
    page.wait_for_timeout(800)
    assert page.evaluate(NSTATES) == solved, "a solved daily came back dealt fresh"
    ctx.close()


def test_a_finished_arcade_daily_comes_back_over_and_counts_once(site, browser):
    ctx = _phone(browser, ZONES[0])
    page = ctx.new_page()
    url = site + "snake.html?daily=" + SERVER_DAY
    page.goto(url)
    page.wait_for_timeout(800)
    page.mouse.click(195, 420)   # the ready screen: a tap starts the snake, which runs into a wall on its own
    page.wait_for_selector(".ar-sheet:not([hidden]) .gs-share-row", timeout=40000)
    count = "() => (JSON.parse(localStorage.getItem('zimi.games.stats')) || { g: {} }).g['snake.html']"
    assert page.evaluate(count)["n"] == 1
    page.goto(url)
    page.mouse.click(195, 420)
    page.wait_for_selector(".ar-sheet:not([hidden]) .gs-share-row, .gs-rest", timeout=10000)
    assert page.evaluate(count)["n"] == 1, "reopening a finished daily counted it again"
    ctx.close()
