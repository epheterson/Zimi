"""Zimi's own ZIMs (Almanac, Games) can be removed from a server and added back
from the Catalog. One list of removed names (ownzims.REMOVED_KEY), admin only;
the file in the package is never touched; open windows hear it as the library
changing.

Eric: "Maybe we should allow delete and 're-add' from catalog".

Run: pytest tests/test_own_zim_remove.py -v
"""

import json
import os
import pathlib
import sys
import threading
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as srv  # noqa: E402
from zimi import changes, manage, ownzims  # noqa: E402

pytestmark = pytest.mark.skipif(
    not all(ownzims.zim_path(o) for o in ownzims.OWN), reason="the own ZIMs are not built"
)


@pytest.fixture
def served(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    # Fixture ZIMs only, in a scratch library: two small encyclopedias (Chess, Cat, the Moon),
    # so Home is not a single ZIM's page and an article can offer a game or the Almanac.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import make_wiki_games_fixture

    zdir = pathlib.Path(make_wiki_games_fixture.build(str(tmp_path)))  # tmp_path/zims
    monkeypatch.setenv("ZIMI_BUILTIN_ZIMS", "1")
    monkeypatch.delenv("ZIMI_APPS", raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data" / "qids"), exist_ok=True)  # where a viewed article's Q-ID is learned
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _call(base, path, body=None):
    req = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _served(base):
    return {z["name"] for z in _call(base, "/list")[1]}


def test_removed_is_a_list_of_known_names_beside_the_apps_switch(served):
    assert ownzims.removed() == frozenset()
    assert ownzims.set_removed("zimi_games", True) and ownzims.set_removed("zimi_games", True)
    assert not ownzims.set_removed("wikipedia_en_all", True)
    assert manage._read_app_update_prefs()[ownzims.REMOVED_KEY] == ["zimi_games"]
    assert ownzims.removed() == {"zimi_games"}
    assert [os.path.basename(p).split("_20")[0] for p in ownzims.zim_paths()] == ["zimi_almanac"]
    ownzims.set_removed("zimi_games", False)
    assert ownzims.removed() == frozenset() and len(ownzims.zim_paths()) == 2
    # A hand-edited prefs file naming something else removes nothing else.
    manage._write_app_update_prefs(**{ownzims.REMOVED_KEY: ["zimi_games", "x", 3]})
    assert ownzims.removed() == {"zimi_games"}
    manage._write_app_update_prefs(**{ownzims.REMOVED_KEY: "zimi_games"})
    assert ownzims.removed() == frozenset()


def test_the_apps_switch_is_a_different_fact(served):
    srv.set_apps_enabled(["maps"])  # hides the Games and Almanac tiles
    assert {"zimi_games", "zimi_almanac"} <= _served(served), "still in the library, search and Discover"
    _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": True})
    assert srv.apps_shown() == frozenset(["maps"]), "removing a ZIM leaves the apps switch alone"


def test_remove_and_add_back_follow_the_library_live(served):
    assert {"zimi_games", "zimi_almanac"} <= _served(served)
    code, d = _call(served, "/manage/own-zims")
    rows = {r["name"]: r for r in d["zims"]}
    assert code == 200 and set(rows) == {"zimi_games", "zimi_almanac"}
    assert all(r["installed"] and r["title"] and r["description"] for r in rows.values())
    assert rows["zimi_games"]["icon"].startswith("data:image/png;base64,")
    start = changes.resume_from(None)
    code, d = _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": True})
    assert code == 200
    assert {r["name"]: r["installed"] for r in d["zims"]} == {"zimi_games": False, "zimi_almanac": True}
    assert "zimi_games" not in _served(served) and "zimi_almanac" in _served(served)
    assert "zimi_games" not in srv.get_zim_files()
    _latest, heard = changes.wait(start, None, 0.1)
    assert {"topic": "library", "by": None} in heard
    # The Catalog still lists it (the file is the package's), and offers Add.
    assert {r["name"]: r["installed"] for r in _call(served, "/manage/own-zims")[1]["zims"]}["zimi_games"] is False
    assert os.path.exists(ownzims.zim_path(ownzims.OWN[0]))
    # Added back: served again at once, no download, announced again.
    start = changes.resume_from(None)
    assert _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": False})[0] == 200
    assert "zimi_games" in _served(served)
    assert {"topic": "library", "by": None} in changes.wait(start, None, 0.1)[1]


def test_it_survives_a_rescan_and_a_restart(served):
    _call(served, "/manage/own-zims", {"name": "zimi_almanac", "removed": True})
    srv.load_cache(force=True)
    assert "zimi_almanac" not in _served(served) and "zimi_games" in _served(served)


def test_manage_delete_of_the_file_is_the_same_removal(served):
    own = os.path.basename(ownzims.zim_path(ownzims.OWN[1]))
    code, d = _call(served, "/manage/delete", {"filename": own})
    assert code == 200 and d["own"] == "zimi_almanac"
    assert "zimi_almanac" not in _served(served)
    assert os.path.exists(ownzims.zim_path(ownzims.OWN[1])), "the packaged file is never deleted"


@pytest.mark.parametrize("body", [{"name": "nope", "removed": True}, {"name": "zimi_games"}, {"name": "zimi_games", "removed": "yes"}, {}])
def test_bad_requests_change_nothing(served, body):
    assert _call(served, "/manage/own-zims", body)[0] == 400
    assert ownzims.removed() == frozenset()


def test_builtin_off_lists_nothing(served, monkeypatch):
    monkeypatch.setenv("ZIMI_BUILTIN_ZIMS", "0")
    assert ownzims.catalog() == []


# ── The same steps in a phone-sized browser, with a second open window ──

SHOTS = os.environ.get("ZIMI_OWN_SHOTS", "")


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def _tiles(pg, expect):
    """The Games and Almanac tiles on Home, given time to become `expect`."""
    pg.wait_for_function("() => mode === 'home' && !!document.querySelector('.stats-grid')", timeout=15000)
    pg.wait_for_function(
        "(n) => document.querySelectorAll('.games-tile, .almanac-tile').length === n", arg=expect, timeout=8000
    )


def _manage(pg, tab):
    pg.goto(pg.url.split("?")[0].split("#")[0].rstrip("/") + "/?manage")
    pg.wait_for_function("() => mode === 'manage' && !!document.querySelector('.manage-tab')", timeout=15000)
    pg.evaluate("(tab) => switchManageTab(tab)", tab)
    pg.wait_for_function("(tab) => manageTab === tab", arg=tab, timeout=15000)


def test_remove_from_library_gone_from_home_add_from_catalog_back(served):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg, other = ctx.new_page(), ctx.new_page()
        pg.goto(served + "/")
        other.goto(served + "/")
        _tiles(pg, 2)
        _tiles(other, 2)
        _shot(pg, "1-home-with-apps")
        # Remove from Manage > Library.
        _manage(pg, "installed")
        row = pg.locator(".catalog-item", has_text="ZimiGames")
        row.wait_for(timeout=15000)
        pg.wait_for_timeout(1500)  # the stream's first announcement redraws the list once
        _shot(pg, "2-library")
        # ZimiGames takes this browser's saved games with it, so its delete asks in a dialog that says so.
        row.locator(".ci-delete-btn").click()
        pg.locator(".pw-confirm #ac-ok").wait_for()
        _shot(pg, "3-confirm")
        pg.locator(".pw-confirm #ac-ok").click()
        pg.wait_for_function("() => !(zimsCache || []).some(z => z.name === 'zimi_games')", timeout=8000)
        assert pg.locator(".catalog-item", has_text="ZimiGames").count() == 0
        _shot(pg, "4-library-after-remove")
        # A second open window hears it without a reload; Home agrees.
        other.wait_for_function("() => !(zimsCache || []).some(z => z.name === 'zimi_games')", timeout=8000)
        _tiles(other, 1)
        assert other.locator(".games-tile").count() == 0
        _shot(other, "5-other-window-home")
        pg.evaluate("goHome()")
        _tiles(pg, 1)
        _shot(pg, "6-home-after-remove")
        pg.reload()
        _tiles(pg, 1)  # and across a reload
        # Catalog: Zimi is the last category (Eric, 2026-10-27); Games offers Add, Almanac reads Installed.
        _manage(pg, "browse")
        card = pg.locator(".browse-cat-card").last
        card.wait_for(timeout=15000)
        assert card.locator(".bcc-name").inner_text().strip() == "Zimi"
        _shot(pg, "7a-catalog-gallery")
        card.click()
        games, almanac = pg.locator("[data-category=zimi]", has_text="ZimiGames"), pg.locator("[data-category=zimi]", has_text="Zimi Almanac")
        games.wait_for(timeout=15000)
        pg.get_by_role("button", name="you already have").click()  # the catalog's ordinary fold of what is installed
        almanac.wait_for()
        _shot(pg, "7b-catalog-zimi")
        assert games.locator(".ci-add-btn").inner_text().strip() == "Add"
        assert almanac.locator(".ci-installed-badge").inner_text().strip() == "Installed"
        assert games.locator("img").count() == 1 and games.locator(".ci-summary").inner_text().strip()
        _shot(pg, "7-catalog-zimi-group")
        games.locator(".ci-add-btn").click()
        pg.wait_for_function("() => document.querySelectorAll('.ci-add-btn[onclick*=_addOwnZim]').length === 0", timeout=8000)
        pg.get_by_role("button", name="you already have").click() if pg.get_by_role("button", name="you already have").count() else None
        games.locator(".ci-installed-badge").wait_for(timeout=8000)
        _shot(pg, "8-catalog-after-add")
        other.wait_for_function("() => (zimsCache || []).some(z => z.name === 'zimi_games')", timeout=8000)
        _tiles(other, 2)
        pg.evaluate("goHome()")
        _tiles(pg, 2)
        _shot(pg, "9-home-after-add")
        pg.reload()
        _tiles(pg, 2)
        br.close()



# ── Links into an app follow its ZIM: "Play Chess", "See it in the Almanac", Game of the Day ──


def _article(pg, base, zim, path):
    # Reading an article in a frame is how Zimi learns its Q-ID (a fixture has no index).
    req = urllib.request.Request("%s/w/%s/%s" % (base, zim, path), headers={"Sec-Fetch-Dest": "iframe"})
    urllib.request.urlopen(req).read()
    pg.goto(base + "/?a=" + zim + "/" + path)
    pg.locator("#reader.open").wait_for(timeout=15000)
    pg.wait_for_timeout(1000)  # the learning is a background thread
    pg.evaluate("() => { _gamesLinks = null; _gamePlayCheck(); }")


def _button(pg, shown):
    pg.wait_for_function(
        "(shown) => { const b = document.getElementById('game-play'); return !!b && b.hidden === !shown; }",
        arg=shown,
        timeout=10000,
    )


def test_play_and_almanac_buttons_follow_their_zims_live(served):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2).new_page()
        # Chess: Play, until the games ZIM is deleted (then at once, no reload), back when added again.
        _article(pg, served, "wikipedia_en_test", "Chess.html")
        _button(pg, True)
        assert "Play Chess" in pg.locator("#game-play").inner_text()
        # It wears the games ZIM's own icon (the ZimiGames tile), not the bare pebble.
        assert pg.locator("#game-play img").get_attribute("src") == "/w/zimi_games/-/icon"
        pg.wait_for_function("() => { const i = document.querySelector('#game-play img'); return i.complete && i.naturalWidth > 0; }", timeout=8000)
        _shot(pg, "10-chess-play")
        assert _call(served, "/manage/delete", {"filename": os.path.basename(ownzims.zim_path(ownzims.OWN[0]))})[0] == 200
        _button(pg, False)
        _shot(pg, "11-chess-no-play")
        _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": False})
        _button(pg, True)
        # The Moon: See it in the Almanac, which opens the Almanac on the Moon.
        _article(pg, served, "wikipedia_en_test", "Moon.html")
        _button(pg, True)
        assert "Almanac" in pg.locator("#game-play").inner_text()
        _shot(pg, "12-moon-almanac")
        _call(served, "/manage/own-zims", {"name": "zimi_almanac", "removed": True})
        _button(pg, False)
        _shot(pg, "13-moon-no-almanac")
        _call(served, "/manage/own-zims", {"name": "zimi_almanac", "removed": False})
        _button(pg, True)
        pg.locator("#game-play").click()
        pg.wait_for_function("() => _almanacOpen === true", timeout=15000)
        _shot(pg, "14-almanac-opened")
        # Cat is neither a game nor in the sky.
        _article(pg, served, "wikipedia_en_test", "Cat.html")
        pg.wait_for_timeout(1500)
        _button(pg, False)
        br.close()


def test_game_of_the_day_card_goes_with_the_games_zim(served):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}).new_page()
        pg.goto(served + "/")
        card = pg.locator(".discover-card", has_text="Game of the Day")
        card.wait_for(timeout=20000)
        _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": True})
        pg.wait_for_function("() => document.querySelectorAll('.discover-card').length > 0 && !/Game of the Day/.test(document.querySelector('#discover-row').innerText)", timeout=10000)
        _shot(pg, "15-discover-without-games")
        _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": False})
        card.wait_for(timeout=15000)
        br.close()


