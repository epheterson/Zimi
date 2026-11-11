"""Manage names the chunk a split book is missing, where it flags a book it
cannot open.

Run: pytest tests/test_split_missing_live.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

I18N = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "i18n",
)


def test_every_language_has_the_message_with_the_file_name():
    for fn in sorted(os.listdir(I18N)):
        with open(os.path.join(I18N, fn), encoding="utf-8") as f:
            text = json.load(f).get("zim_missing_chunk", "")
        assert "{file}" in text, fn


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim, split_fixture_zim
    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    chunks = split_fixture_zim(
        build_fixture_zim(str(zdir / "splitbook_en_all_2026-01.zim")), 100
    )
    os.remove(chunks[1])
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def test_the_installed_list_names_the_missing_chunk(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_context(**p.devices["iPhone 13"]).new_page()
        pg.goto(served + "/?manage")
        pg.wait_for_function(
            "() => typeof switchManageTab === 'function'", timeout=15000
        )
        pg.evaluate("() => switchManageTab('installed')")
        pg.wait_for_selector("#manage-installed .ci-bad", timeout=15000)
        assert "splitbook_en_all_2026-01.zimab" in pg.inner_text(
            "#manage-installed .ci-bad"
        )
        br.close()
