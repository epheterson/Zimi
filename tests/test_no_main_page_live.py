"""A book with no main page opens on a way in, not an empty header.

Some ZIMs (hand-made, old scrapers) name no main page. Opening one showed
its title and description and nothing under them. It now offers the two
ways into any book: search inside it, and a random page of it.

Run: pytest tests/test_no_main_page_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _build_no_main(path):
    from libzim.writer import Creator

    from conftest_zim import _Article

    with Creator(path).config_indexing(True, "eng") as c:
        for p, t in (("A/One", "First page"), ("A/Two", "Second page")):
            c.add_item(
                _Article(p, t, f"<html><body><h1>{t}</h1></body></html>".encode())
            )
        for key, value in (
            ("Title", "No Front Door"),
            ("Language", "eng"),
            ("Description", "two pages"),
        ):
            c.add_metadata(key, value)
    return path


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    _build_no_main(str(zdir / "nofront_en_all_2026-01.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def test_a_book_without_a_main_page_offers_search_and_a_random_page(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_context(**p.devices["iPhone 13"]).new_page()
        pg.goto(served + "/w/nofront")
        pg.wait_for_selector(".source-header h1", timeout=15000)
        assert "No Front Door" in pg.inner_text(".source-header h1")
        pg.wait_for_selector("#output .nomain-ways", timeout=15000)
        pg.click("#output .nomain-search")
        assert pg.evaluate(
            "() => document.activeElement === document.getElementById('q')"
        )
        pg.click("#output .nomain-random")
        pg.wait_for_function(
            "() => typeof currentArticle !== 'undefined' && currentArticle && currentArticle.zim === 'nofront'",
            timeout=15000,
        )
        assert pg.evaluate("() => currentArticle.path") in ("A/One", "A/Two")
        br.close()
