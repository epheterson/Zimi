"""An open article is loaded again, in place, when the ZIM under it is replaced (auto-update): the library topic of
/events tells every window, the window sees the ZIM's file changed, and the reader's frame reloads where it was.

Run: pytest tests/test_open_zim_live_browser.py -v
"""

import os
import shutil
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PAGE = (
    '<!doctype html><html><head><meta charset="utf-8"><title>Live</title></head><body>'
    '<h1 id="v">%s</h1>' + "".join("<p>filler %d</p>" % i for i in range(400)) + "</body></html>"
)


def _zim(tmp, version, out):
    from zimi import creator

    src = tmp / ("src_" + version)
    src.mkdir()
    (src / "index.html").write_text(PAGE % version, encoding="utf-8")
    (src / "zimi.txt").write_text("title: Live\n", encoding="utf-8")
    creator.create_folder_zim(str(src), out_path=str(out), register=False)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("live")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    _zim(tmp, "first", tmp / "first.zim")
    _zim(tmp, "second", tmp / "second.zim")
    target = tmp / "zims" / "live_2026-10.zim"
    shutil.copy(tmp / "first.zim", target)
    saved = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield {
        "base": "http://127.0.0.1:%d" % httpd.server_address[1],
        "swap": lambda: (shutil.copy(tmp / "second.zim", target), srv.load_cache(force=True)),
    }
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved


def test_a_replaced_zim_shows_new_at_the_same_place(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(viewport={"width": 390, "height": 844}, service_workers="block").new_page()
        try:
            pg.goto(served["base"] + "/?a=live%2Findex.html", wait_until="load")
            heading = "() => { const f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.getElementById('v') && f.contentDocument.getElementById('v').textContent; }"
            pg.wait_for_function(heading, timeout=60000)
            assert pg.evaluate(heading) == "first"
            pg.evaluate("() => document.getElementById('reader-frame').contentWindow.scrollTo(0, 900)")
            pg.wait_for_timeout(1500)   # the window has its stream open
            served["swap"]()
            pg.wait_for_function("() => { %s }" % ("const h = (%s)(); return h === 'second';" % heading), timeout=30000)
            y = pg.evaluate("() => document.getElementById('reader-frame').contentWindow.scrollY")
            assert abs(y - 900) < 60, y
        finally:
            br.close()
