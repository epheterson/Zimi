"""The shelf's "New" row: the games that arrived with this release, one row under the table, while that release is current.

games.json carries an `added` release on each; the shelf shows the games of the highest one. A search, a room or a type chip
takes the row away like the Daily row. Each kind is dealt in turn so the row is not one picture.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_new_row_browser.py -v
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


def test_the_row_lists_the_latest_release_only(browser, served):
    if not any("added" in r for r in rows()):
        pytest.skip("no game in games.json says which release added it")
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = ctx.new_page()
    page.goto("%s/index.html" % served)
    page.wait_for_selector(".ar-new a.ar-game")
    frames(page)
    latest = max(
        (tuple(map(int, r["added"].split("."))) for r in rows() if "added" in r)
    )
    want = {
        r["path"]
        for r in rows()
        if "added" in r and tuple(map(int, r["added"].split("."))) == latest
    }
    got = page.eval_on_selector_all(
        ".ar-new a.ar-game", "els => els.map(e => e.getAttribute('href'))"
    )
    assert set(got) == want and len(got) == len(want)
    # Directly under the table, ahead of the Daily row.
    order = page.eval_on_selector_all(
        ".sh-top > section",
        "els => els.map(e => e.className.split(' ').filter(c => /^ar-(continue|world|new|daily)$/.test(c))[0])",
    )
    # The table, the world's favorites, what is new, then the rest: the games that use your library are not what the shelf opens on.
    assert order[:3] == ["ar-continue", "ar-world", "ar-new"], order
    assert order.index("ar-new") < order.index("ar-daily")
    world = page.eval_on_selector_all(
        ".ar-world a.ar-game", "els => els.map(e => e.getAttribute('href'))"
    )
    assert (
        world[:3] == ["chess.html", "solitaire.html", "checkers.html"]
        and len(world) == 13
    ), world  # chess is in the row even while the idle table suggests it
    sections = page.eval_on_selector_all(
        ".sh-list > section", "els => els.map(e => e.querySelector('h2').id)"
    )
    assert sections[-1] == "ar-library" and sections[0] != "ar-library", sections
    # Not one picture ten times: the first six are not all one kind.
    kinds = {r["path"]: r["kind"] for r in rows() if "kind" in r}
    assert len({kinds[p] for p in got[:6]}) >= 3
    # A search takes it away, clearing the search brings it back.
    page.fill(".sh-search input", "chess")
    frames(page)
    assert page.locator(".ar-new").is_hidden()
    page.fill(".sh-search input", "")
    frames(page)
    assert page.locator(".ar-new").is_visible()
    ctx.close()


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
    assert page.locator(".ar-new").count() == 0
    # Without a New row the shelf still opens on the table and the world's favorites, and the library games come last.
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
