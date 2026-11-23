"""A finished Create job's card has one quiet line to openZIM's instructions for sharing a ZIM: a plain link that opens in
a new tab (no fetch, no call by Zimi), only when a ZIM was made.

Run: pytest tests/test_create_share_link_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

WAIT_MS = 30_000
SCREENSHOT_DIR = os.environ.get("ZIMI_SHOT_DIR", "")


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("createshare")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


def test_the_done_card_links_to_the_instructions_for_sharing(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, service_workers="block")
        pg = ctx.new_page()
        pg.goto(served + "/#create", wait_until="commit", timeout=WAIT_MS)
        pg.wait_for_function("() => typeof _createMountDone === 'function'", timeout=WAIT_MS)
        # The run panel a job draws into (the card's place), as a running job would have made it.
        pg.evaluate("document.getElementById('create-run').innerHTML = _createRunShellHtml({ mode: 'folder', request: {} })")
        pg.evaluate("_createMountDone({ mode: 'folder', request: {}, result: { name: 'my_notes_en', title: 'My notes' } })")
        link = pg.locator(".create-done-share")
        assert link.count() == 1
        assert link.get_attribute("href") == "https://wiki.openzim.org/wiki/Contribute_a_ZIM_file"
        assert link.get_attribute("target") == "_blank" and "noopener" in link.get_attribute("rel")
        assert link.inner_text().strip() == "Share it with the Kiwix community"
        # Nothing was made (no name): no line.
        pg.evaluate("_createMountDone({ mode: 'folder', request: {}, result: {} })")
        assert pg.locator(".create-done-share").count() == 0
        pg.evaluate("_createMountDone({ mode: 'folder', request: {}, result: { name: 'my_notes_en', title: 'My notes' } })")
        if SCREENSHOT_DIR:
            # The run panel is shown while a job is on screen: show it, as a job would.
            pg.evaluate("for (var e = document.getElementById('create-done-slot'); e; e = e.parentElement) { e.hidden = false; }")
            pg.locator(".create-done").scroll_into_view_if_needed()
            pg.screenshot(path=os.path.join(SCREENSHOT_DIR, "create-share-390.png"))
        br.close()
