"""Anything that opens Manage on a protected server asks for the password
first, over the page you are on, and opens Manage after: Create's way.

Eric (2026-09-21): "don't like how the others show manage with it on top
saying loading catalog... while it waits for the password". A Catalog tile
(an app with nothing to show yet opens its catalog category) painted Manage,
"Loading catalog...", under the sign-in modal. Now the home page stays behind
the modal; signed in, Manage opens on the catalog category; cancelled, the
home page is still there.

Run: pytest tests/test_signin_first_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PASSWORD = "adminpw-1"
HOME = "() => typeof mode !== 'undefined' && mode === 'home' && !!document.querySelector('.stats-grid')"
MODAL = "() => document.getElementById('pw-overlay').classList.contains('open')"
# What is behind the modal: the mode, and whether Manage's markup is painted.
BEHIND = "() => ({mode: mode, manage: !!document.querySelector('.manage-tab'), loading: document.body.innerText.indexOf('Loading catalog') >= 0})"


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim, build_wiki_fixture_zim

    import zimi.server as srv
    from zimi import manage
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    build_fixture_zim(str(zdir / "water.zim"))
    for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER", "ZIMI_API_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    manage._set_manage_password(PASSWORD)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _open_home(pw, served):
    br = pw.chromium.launch()
    pg = br.new_page(
        viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
    )
    pg.goto(served + "/")
    pg.wait_for_function(HOME, timeout=15000)
    pg.wait_for_function(
        "() => typeof _manageProbed !== 'undefined' && _manageProbed", timeout=10000
    )
    return br, pg


def test_a_catalog_tile_asks_first_and_opens_manage_after(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _open_home(pw, served)
        # A Catalog tile: an app with nothing installed opens its category.
        pg.evaluate("() => { _openCategory('maps'); }")  # not awaited: it waits on the sign-in
        pg.wait_for_function(MODAL, timeout=5000)
        pg.wait_for_timeout(600)
        behind = pg.evaluate(BEHIND)
        assert behind == {"mode": "home", "manage": False, "loading": False}, behind
        pg.fill("#pw-input", PASSWORD)
        pg.keyboard.press("Enter")
        pg.wait_for_function(
            "() => mode === 'manage' && manageTab === 'browse'", timeout=10000
        )
        assert not pg.evaluate(MODAL)
        assert pg.evaluate("manageCategoryFilter") == "maps"
        br.close()


@pytest.mark.parametrize(
    "opener",
    ["enterManage()", "_openDownloadsView()"],
    ids=["gear", "downloads"],
)
def test_cancelled_the_page_stays(served, opener):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _open_home(pw, served)
        pg.evaluate("() => { %s; }" % opener)
        pg.wait_for_function(MODAL, timeout=5000)
        assert pg.evaluate(BEHIND)["manage"] is False
        pg.click("#pw-cancel")
        pg.wait_for_timeout(400)
        assert not pg.evaluate(MODAL)
        assert pg.evaluate(BEHIND) == {
            "mode": "home",
            "manage": False,
            "loading": False,
        }
        br.close()


def test_a_cold_manage_link_shows_the_library_behind_the_sign_in(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 390, "height": 844})
        pg.goto(served + "/?manage=library")
        pg.wait_for_function(MODAL, timeout=10000)
        pg.wait_for_timeout(1500)  # the boot's re-check comes after the probe
        behind = pg.evaluate(BEHIND)
        assert behind["manage"] is False, behind
        assert not pg.evaluate(
            "document.documentElement.classList.contains('manage-boot')"
        )
        pg.fill("#pw-input", PASSWORD)
        pg.keyboard.press("Enter")
        pg.wait_for_function(
            "() => mode === 'manage' && !!document.querySelector('.manage-tab')",
            timeout=10000,
        )
        br.close()


def test_create_still_asks_first_and_opens_after(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _open_home(pw, served)
        pg.evaluate("() => { openCreate(); }")
        pg.wait_for_function(MODAL, timeout=5000)
        assert pg.evaluate("_createOpen") is False
        pg.fill("#pw-input", PASSWORD)
        pg.keyboard.press("Enter")
        pg.wait_for_function("() => _createOpen === true", timeout=10000)
        assert not pg.evaluate(MODAL)
        br.close()
