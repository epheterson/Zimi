"""The shelf's "Featured" row: a pick of the library that changes once a day, one row after World favorites.

The pick is seeded by the Daily row's day, so a day is one row for everyone; no game of World favorites is in it. A search, a room
or a type chip takes the row away like the Daily row. The row is as long as the games a release added (games.json `added`).

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_featured_row_browser.py -v
"""

import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames  # noqa: E402
from test_games_persist_browser import GAMES, VIEW, browser, served  # noqa: E402,F401


def rows():
    with open(os.path.join(GAMES, "games.json"), encoding="utf-8") as f:
        return json.load(f)


def test_added_is_a_release_and_names_a_real_page():
    for r in rows():
        if "added" in r:
            assert re.fullmatch(r"\d+\.\d+", r["added"]), r
            assert os.path.exists(os.path.join(GAMES, r["path"])), r["path"]


def _shelf_on(browser, served, day=None):
    """The shelf on a phone, the device clock fixed to `day` (off Zimi the device's own day is the server day)."""
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = ctx.new_page()
    if day:
        page.clock.set_fixed_time(day + "T12:00:00")
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-featured a.ar-game")
    frames(page)
    return ctx, page


FEATURED = "els => els.map(e => e.getAttribute('href'))"


def test_the_row_is_the_days_pick_and_sits_between_world_and_daily(browser, served):
    if not any("added" in r for r in rows()):
        pytest.skip("no game in games.json says which release added it")
    latest = max(tuple(map(int, r["added"].split("."))) for r in rows() if "added" in r)
    count = len({r["path"] for r in rows() if "added" in r and tuple(map(int, r["added"].split("."))) == latest})
    ctx, page = _shelf_on(browser, served, "2026-11-20")
    got = page.eval_on_selector_all(".ar-featured a.ar-game", FEATURED)
    assert len(got) == count == len(set(got)), (got, count)
    assert page.locator(".ar-new").count() == 0
    order = page.eval_on_selector_all(
        ".sh-top > section",
        "els => els.map(e => e.className.split(' ').filter(c => /^ar-(continue|world|featured|daily)$/.test(c))[0])",
    )
    assert order[:3] == ["ar-continue", "ar-world", "ar-featured"], order
    assert order.index("ar-featured") < order.index("ar-daily")
    world = page.eval_on_selector_all(".ar-world a.ar-game", "els => els.filter(e => getComputedStyle(e).display !== 'none' && !e.hidden && e.getClientRects().length).map(e => e.getAttribute('href'))")
    assert world[:3] == ["chess.html", "solitaire.html", "checkers.html"] and len(world) == 13, world
    assert not {g.split("?")[0] for g in got} & set(world), "a World favorite is also featured"
    sections = page.eval_on_selector_all(".sh-list > section", "els => els.map(e => e.querySelector('h2').id)")
    assert sections[-1] == "ar-library" and sections[0] != "ar-library", sections
    heading = page.inner_text(".ar-featured h2").strip().lower()
    assert heading == "featured", heading
    # A search takes it away, clearing the search brings it back.
    page.fill(".sh-search input", "chess")
    frames(page)
    assert page.locator(".ar-featured").is_hidden()
    page.fill(".sh-search input", "")
    frames(page)
    assert page.locator(".ar-featured").is_visible()
    ctx.close()


def test_the_same_day_is_the_same_row_and_another_day_is_another(browser, served):
    seen = {}
    for label, day in (("a1", "2026-11-20"), ("a2", "2026-11-20"), ("b", "2026-11-21"), ("c", "2026-11-22")):
        ctx, page = _shelf_on(browser, served, day)
        seen[label] = page.eval_on_selector_all(".ar-featured a.ar-game", FEATURED)
        ctx.close()
    assert seen["a1"] == seen["a2"], seen
    assert seen["b"] != seen["a1"] or seen["c"] != seen["a1"], seen


def test_no_added_no_row(browser, served):
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = ctx.new_page()
    plain = [{k: v for k, v in r.items() if k != "added"} for r in rows()]
    page.route(
        "**/games.json",
        lambda route: route.fulfill(
            body=json.dumps(plain), content_type="application/json"
        ),
    )
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-daily a.ar-game")
    assert page.locator(".ar-featured").count() == 0 and page.locator(".ar-new").count() == 0
    # Without a Featured row the shelf still opens on the table and the world's favorites, and the library games come last.
    order = page.eval_on_selector_all(
        ".sh-top > section",
        "els => els.map(e => e.className.split(' ').filter(c => /^ar-(continue|world|daily)$/.test(c))[0])",
    )
    assert order[:2] == ["ar-continue", "ar-world"], order
    sections = page.eval_on_selector_all(
        ".sh-list > section", "els => els.map(e => e.querySelector('h2').id)"
    )
    assert sections[-1] == "ar-library" and sections[0] != "ar-library", sections
    ctx.close()


def test_kiwix_viewer_links_keep_the_opening_rows(browser, served):
    """kiwix-serve 3.8's viewer rewrites every link of the framed page to "/viewer#<book>/<path>" once it has loaded, before
    games.json comes back: the table, World favorites and the Daily row still find their tiles (the shelf opened on the
    Library group in Kiwix without this)."""
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = ctx.new_page()
    body = json.dumps(rows())

    def late(route):
        page.wait_for_timeout(300)
        route.fulfill(body=body, content_type="application/json")

    page.route("**/games.json", late)
    page.add_init_script(
        "document.addEventListener('DOMContentLoaded', function () {"
        " document.querySelectorAll('a[href]').forEach(function (a) { var h = a.getAttribute('href');"
        " if (!/^(https?:|#|\\/)/.test(h)) a.setAttribute('href', '/viewer#zimi_games_2026-11/' + h); }); });"
    )
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-daily a.ar-game")
    order = page.eval_on_selector_all(
        ".sh-top > section",
        "els => els.map(e => e.className.split(' ').filter(c => /^ar-(continue|world|daily)$/.test(c))[0])",
    )
    assert order[:2] == ["ar-continue", "ar-world"] and "ar-daily" in order, order
    ctx.close()


@pytest.fixture(scope="module")
def slow_shelf_js():
    """The games folder served with shelf.js held back: a slow phone or a cold cache, where games.json is answered first."""
    import functools
    import http.server
    import threading
    import time

    answered = threading.Event()   # games.json has been sent

    class Slow(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

        def do_GET(self):
            path = self.path.split("?")[0]
            if path.endswith("/shelf.js"):
                # shelf.js leaves only after games.json has been answered, and a moment after, so the order is not left to chance.
                answered.wait(20)
                time.sleep(SHELF_JS_AFTER_S)
            super().do_GET()
            if path.endswith("/games.json"):
                answered.set()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Slow, directory=GAMES))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


SHELF_JS_AFTER_S = 0.6


def test_rows_survive_shelf_js_arriving_after_games_json(browser, slow_shelf_js):
    """games.json can answer before shelf.js has arrived: the rows must wait for the page's scripts, or shelf.js reads them as
    sections of games, throws, and the shelf is left half built until a reload."""
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("%s/index.html" % slow_shelf_js)
    page.wait_for_selector(".sh-top > .ar-featured a.ar-game", timeout=30000)
    frames(page)
    assert errors == []
    # shelf.js ran: it made its chips and put both rows in the top block, once each.
    assert page.locator(".sh-top > .ar-world").count() == 1 and page.locator(".sh-top > .ar-featured").count() == 1
    assert page.locator(".sh-bar").count() >= 1
    assert page.locator(".ar-world a.ar-game:visible").count() >= 10
    ctx.close()


def test_featured_row_comes_when_games_json_fails_once(browser, served):
    """A cold cache or a service worker still starting can fail the first games.json: the shelf asks again, so the Featured row
    is there without a reload, and World favorites (which need no data) were never waiting for it."""
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = ctx.new_page()
    asked = []
    body = json.dumps(rows())

    def flaky(route):
        asked.append(1)
        if len(asked) == 1:
            route.fulfill(status=503, body="")
        else:
            route.fulfill(body=body, content_type="application/json")

    page.route("**/games.json", flaky)
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-world a.ar-game")
    page.wait_for_selector(".ar-featured a.ar-game", timeout=10000)
    assert len(asked) >= 2
    ctx.close()


def test_kiwix_viewer_tile_keeps_its_book_path_through_a_tap(browser, served):
    """In kiwix-serve's viewer a tile's link is "/viewer#<book>/<path>": a tap adds the room, never drops the book's path, and a
    link written that way still resolves to its game path."""
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = ctx.new_page()
    page.add_init_script(
        "document.addEventListener('DOMContentLoaded', function () {"
        " document.querySelectorAll('a[href]').forEach(function (a) { var h = a.getAttribute('href');"
        " if (!/^(https?:|#|\\/)/.test(h)) a.setAttribute('href', '/viewer#zimi_games_2026-11/' + h); }); });"
    )
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-daily a.ar-game")
    got = page.evaluate(
        """() => {
          document.addEventListener('click', function (e) { e.preventDefault(); });
          var a = document.querySelector('.sh-list a.ar-game');
          a.click();
          var kept = a.getAttribute('href');
          var t = document.createElement('a');
          t.setAttribute('href', '/viewer#zimi_games_2026-11/hearts.html#room=night');
          return [kept, window.ZimiShelf.pathOf(t)];
        }"""
    )
    assert got[0].startswith("/viewer#zimi_games_2026-11/") and got[0].endswith(".html"), got
    assert got[1] == "hearts.html", got
    ctx.close()
