"""A spelling suggestion never sits above results that already answer the search.

The full search suggested "water" for "wat" although a title phase result, Water purification, was on screen: the
suggestion is computed where that result is not seen. A word that is not in any title still gets its suggestion.

Run: pytest tests/test_did_you_mean_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.search as zsearch  # noqa: E402
import zimi.server as srv  # noqa: E402


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "wikipedia_en_all_2026-01.zim"), {"Name": "wikipedia_en_all"})
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    # The library's words, as a big library has them: "water" is one, so "wat" has a correction in hand.
    monkeypatch.setattr(zsearch, "_ensure_vocab", lambda: {"water": 50, "purification": 20, "fire": 30})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _search(pg, served, query):
    pg.goto(served + "/")
    pg.wait_for_function("() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0", timeout=30000)
    pg.fill("#q", query)
    pg.keyboard.press("Enter")
    pg.wait_for_function("() => document.querySelector('#output .result, #output .empty, #output .did-you-mean')", timeout=30000)
    pg.wait_for_timeout(1500)
    return pg.evaluate(
        "() => ({ results: document.querySelectorAll('#output .result, #output a.result').length, dym: !!document.querySelector('#output .did-you-mean') })"
    )


def test_a_result_that_answers_the_search_leaves_no_suggestion_above_it(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True).new_page()
            got = _search(pg, served, "wat")
            assert got["results"] >= 1 and not got["dym"], got
        finally:
            br.close()
