"""The reader's Save is not offered on Zimi's own stand-in pages.

A link to an article the ZIM does not hold opens Zimi's "This article isn't
in this ZIM" page (http.py _UNCAPTURED_PAGE, marked <meta name="zimi-page">).
It is not an article: the header's bookmark steps aside there, as it does on
an app's page, and comes back on the next real article.

Run: pytest tests/test_own_page_save_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import books_sources_fixture as fx  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import http  # noqa: E402

FRAME_DOC = "() => { const f = document.getElementById('reader-frame'); return f && f.contentDocument; }"
SAVE_SHOWN = (
    "() => { const b = document.getElementById('library-btn'); return !!b && getComputedStyle(b).display !== 'none'; }"
)


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    zdir = tmp_path / "zims"
    zdir.mkdir()
    page = "<html><head><title>Water</title></head><body><h1>Water</h1><p>%s</p></body></html>" % (
        "Water is drawn from wells, rivers and rain. " * 40
    )
    fx.build_zim(
        str(zdir / "water_en_all_2024-08.zim"),
        {"Name": "water_en_all", "Title": "Water"},
        {"Water": ("text/html", page, "Water")},
        "Water",
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), http.ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], srv.list_zims()[0]["name"]
    httpd.shutdown()
    srv.release_zim_handles(list(srv.get_zim_files()))


@pytest.mark.parametrize("viewport", [{"width": 390, "height": 844}, {"width": 1280, "height": 800}])
def test_save_steps_aside_on_the_missing_article_page(served, viewport):
    from playwright.sync_api import sync_playwright

    base, name = served
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_context(viewport=viewport).new_page()
            # A real article first: Save is there.
            pg.goto(base + "/?a=" + name + "%2FWater")
            pg.wait_for_function(
                "() => { const d = (%s)(); return d && d.querySelector('h1') && d.querySelector('h1').textContent === 'Water'; }"
                % FRAME_DOC,
                timeout=20000,
            )
            pg.wait_for_function(SAVE_SHOWN, timeout=5000)
            # A link to an article the ZIM does not hold: Zimi's own page, no Save.
            pg.evaluate("() => openArticle(%r, 'No_such_article')" % name)
            pg.wait_for_function(
                "() => { const d = (%s)(); return d && d.querySelector('meta[name=\"zimi-page\"]'); }" % FRAME_DOC,
                timeout=20000,
            )
            pg.wait_for_function("() => !(%s)()" % SAVE_SHOWN, timeout=5000)
            # The b key does not save it either.
            pg.keyboard.press("b")
            assert pg.evaluate("() => Saved.itemsFor({}).length") == 0
            # Back on a real article, Save is offered again.
            pg.evaluate("() => openArticle(%r, 'Water')" % name)
            pg.wait_for_function(SAVE_SHOWN, timeout=20000)
        finally:
            br.close()
