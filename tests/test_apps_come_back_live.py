"""An app turned on or off stays that way after leaving and coming back (#98).

The reporter's steps, in a real browser: turn Bookshelf on in Server
settings, leave, come back: it was gone until a refresh. Chrome's Back shows
the shell it kept from before the change, without asking the server, and the
shell carries the apps offered (data-zimi-apps). Every boot asks /whoami
before it draws, so /whoami carries the apps too and the client takes them
from there. Turning an app off, and an account's own switch, are held to the
same steps, signed in and out.

Run: pytest tests/test_apps_come_back_live.py -v
"""

import json
import os
import sys
import threading
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PASSWORD = "correct horse 1"
HOME = "() => typeof mode !== 'undefined' && mode === 'home' && !!document.querySelector('.stats-grid')"


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim, build_wiki_fixture_zim

    import zimi.server as srv
    from zimi import users
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    # Two ZIMs, so the home page is the home page (one opens itself).
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    build_fixture_zim(str(zdir / "water.zim"))
    monkeypatch.delenv("ZIMI_APPS", raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    users.create_user("alice", PASSWORD, role="user")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _server_apps(base, shown):
    """The switch in Server settings, set from elsewhere (another device)."""
    req = urllib.request.Request(
        base + "/manage/apps",
        data=json.dumps({"shown": shown}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        assert r.status == 200


def _bookshelf_on_home(pg):
    pg.wait_for_function(HOME, timeout=15000)
    pg.wait_for_timeout(300)
    return pg.locator(".books-tile").count() == 1


def _leave_and_come_back(pg):
    pg.evaluate("goHome()")
    pg.wait_for_function(HOME, timeout=15000)
    pg.goto("about:blank")  # leave
    pg.go_back()  # come back


@pytest.mark.parametrize("on", [True, False], ids=["turned-on", "turned-off"])
def test_bookshelf_switched_in_server_settings_holds_after_leaving(served, on):
    from playwright.sync_api import sync_playwright

    # Turning on starts from every app off (#88's state), off from Bookshelf alone.
    _server_apps(served, [] if on else ["books"])
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(served + "/")
        assert _bookshelf_on_home(pg) is not on
        # 1. enable (or disable) Bookshelf, in Server settings
        pg.goto(served + "/?manage=preferences")
        pick = pg.locator("#ms-apps .app-pick", has_text="Bookshelf")
        pick.wait_for(timeout=15000)
        # Each app is a row with the Settings switch; a tap anywhere on it flips it.
        assert pick.locator("input[role=switch]").is_checked() is (not on)
        pick.click()
        pg.wait_for_function(
            "(on) => (document.body.dataset.zimiApps || '').split(',').includes('books') === on",
            arg=on,
            timeout=5000,
        )
        # 2. leave, 3. come back
        _leave_and_come_back(pg)
        assert _bookshelf_on_home(pg) is on, "Bookshelf %s after coming back" % (
            "gone" if on else "back"
        )
        br.close()


def _sign_in(pg):
    status = pg.evaluate(
        "(pw) => doLogin('alice', pw, true).then(r => r.status)", PASSWORD
    )
    assert status == 200
    pg.reload()
    pg.wait_for_function(
        "() => _userSession && _userSession.name === 'alice'", timeout=15000
    )


def test_signed_in_the_server_switch_and_the_accounts_hold_after_leaving(served):
    from playwright.sync_api import sync_playwright

    _server_apps(served, [])
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(served + "/")
        _sign_in(pg)
        assert not _bookshelf_on_home(pg)
        # The server offers Bookshelf again (the admin, on another device)...
        _server_apps(served, ["books"])
        # ...and this page, left and come back to, is told.
        _leave_and_come_back(pg)
        assert _bookshelf_on_home(
            pg
        ), "the server's Bookshelf missing after coming back"
        # The account's own switch: off, then on again, each held the same way.
        for on in (False, True):
            pg.evaluate("(on) => _setUserApp('books', on)", on)
            pg.wait_for_function(
                "(on) => (_userPrefs.shown || []).includes('books') === on",
                arg=on,
                timeout=5000,
            )
            _leave_and_come_back(pg)
            assert (
                _bookshelf_on_home(pg) is on
            ), "the account's choice lost after coming back"
        br.close()
