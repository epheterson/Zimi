"""A bookmark added while the bookmarks list is open shows up in it (#96).

The reporter's steps, in a real browser: open the Bookmarks list, bookmark
the article with the reader's button. The list drew what was saved when it
opened and nothing redrew it, so the new bookmark only appeared after the
list was closed and opened again. Removing one had the same problem.
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_wiki_fixture_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def test_a_bookmark_added_with_the_list_open_appears_in_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(served + "/w/wiki/A/Mercury_(planet)")
        pg.wait_for_function(
            "() => typeof currentArticle !== 'undefined' && currentArticle",
            timeout=30000,
        )
        pg.evaluate("toggleLibraryPanel('bookmarks')")
        panel = pg.locator("#history-panel")
        assert "Mercury" not in panel.inner_text()

        pg.click("#library-btn")  # the reader's bookmark button
        pg.wait_for_timeout(300)
        assert pg.evaluate("Saved.all().length") == 1
        assert (
            "Mercury" in panel.inner_text()
        ), "the open list did not show the new bookmark"

        pg.click("#library-btn")  # and taking it away again
        pg.wait_for_timeout(300)
        assert pg.evaluate("Saved.all().length") == 0
        assert (
            "Mercury" not in panel.inner_text()
        ), "the open list kept a removed bookmark"
        br.close()


# The reader's bookmark button, filled while the article is saved.
BUTTON = "() => document.querySelector('#library-btn svg').getAttribute('fill') === 'currentColor' ? 'filled' : 'empty'"
EMPTIED = "() => document.querySelector('#library-btn svg').getAttribute('fill') !== 'currentColor'"
READING = "() => typeof currentArticle !== 'undefined' && currentArticle"
SIZE = {"width": 1280, "height": 900}


def _remove_in_the_list(pg, title):
    """The row's menu in the open list, and Remove."""
    pg.locator("#history-panel .bm-name", has_text=title).first.click(button="right")
    pg.locator(".ctx-item.danger[data-action='remove']").click()
    pg.wait_for_timeout(300)


def test_removing_it_in_the_list_empties_the_readers_button(served):
    """#96, tripplehelix: "The bookmark icon at the top of the page doesn't
    update when doing the opposite, removing from the sidebar." Only the
    page's own controls, so the same steps run on 1.11.0, where it failed."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport=SIZE)
        pg.goto(served + "/w/wiki/A/Mercury_(planet)")
        pg.wait_for_function(READING, timeout=30000)
        pg.click("#library-btn")
        pg.wait_for_timeout(300)
        assert pg.evaluate(BUTTON) == "filled"
        pg.evaluate("toggleLibraryPanel('bookmarks')")
        _remove_in_the_list(pg, "Mercury")
        assert "Mercury" not in pg.locator("#history-panel").inner_text()
        assert pg.evaluate(BUTTON) == "empty", "the button still says saved"
        br.close()


def test_a_removal_in_another_tab_or_on_another_device_empties_it(served):
    """Every way the article stops being saved reaches the button: another tab
    of this browser, and another device on the same account."""
    from playwright.sync_api import sync_playwright

    from zimi import users

    users.create_user("alice", "correct horse 1", role="user")
    article = served + "/w/wiki/A/Mercury_(planet)"

    def signed_in(ctx):
        pg = ctx.new_page()
        pg.goto(article)
        pg.wait_for_function(READING, timeout=30000)
        pg.evaluate("doLogin('alice', 'correct horse 1', true)")
        pg.reload()
        pg.wait_for_function(READING, timeout=30000)
        pg.wait_for_function("() => Saved.account() === 'alice'", timeout=10000)
        return pg

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        phone = br.new_context(viewport=SIZE)
        pg = signed_in(phone)
        pg.click("#library-btn")
        pg.wait_for_timeout(300)
        assert pg.evaluate(BUTTON) == "filled"

        # Another tab of this browser takes it out of the list.
        tab = phone.new_page()
        tab.goto(served + "/")
        tab.wait_for_function("() => Saved.all().length === 1", timeout=10000)
        tab.evaluate("toggleLibraryPanel('bookmarks')")
        _remove_in_the_list(tab, "Mercury")
        pg.wait_for_function(EMPTIED, timeout=5000)

        # Saved again here, then taken out on another device on the account.
        pg.click("#library-btn")
        pg.wait_for_timeout(300)
        assert pg.evaluate(BUTTON) == "filled"
        pg.evaluate("_savedPush()")
        tablet = signed_in(br.new_context(viewport=SIZE))
        tablet.evaluate("_savedPull()")
        tablet.wait_for_function("() => Saved.all().length === 1", timeout=10000)
        tablet.evaluate("toggleLibraryPanel('bookmarks')")
        _remove_in_the_list(tablet, "Mercury")
        tablet.evaluate("_savedPush()")
        pg.evaluate("_savedPull()")  # as coming back to the tab does
        pg.wait_for_function(EMPTIED, timeout=5000)
        br.close()
