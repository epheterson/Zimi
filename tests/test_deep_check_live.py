"""The deep check's button in Manage, beside Check.

It runs the checksum read (health.start_check(deep=True)) in the
background: progress in bytes and by book, Cancel, picked up again after
leaving the page, a time estimate before a long one starts, and failed books
in the same rows as Check's.

Run: pytest tests/test_deep_check_live.py -v   (SHOT_DIR=... keeps screenshots)
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

GB = 1000**3  # _fmtBytes counts in powers of ten
RUNNING = {
    "phase": "running",
    "deep": True,
    "done": 3,
    "total": 12,
    "bytes_done": 12 * GB,
    "bytes_total": 40 * GB,
    "current": "Wikipedia",
    "eta_seconds": 1500,
    "report": None,
}


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim
    from test_checksum_check import _flip
    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / "good_en_all_2026-01.zim"), metadata={"Title": "Good Book"}
    )
    bad = build_fixture_zim(
        str(zdir / "bad_en_all_2026-01.zim"), metadata={"Title": "Bad Book"}
    )
    _flip(bad, os.path.getsize(bad) // 2)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


@pytest.fixture
def phone():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            color_scheme="dark",
            # The page's service worker would answer the stubbed polls itself.
            service_workers="block",
        )
        yield ctx.new_page()
        br.close()


def _shot(pg, name):
    d = os.environ.get("SHOT_DIR")
    if d:
        pg.locator("#library-health-btn").scroll_into_view_if_needed()
        pg.screenshot(path=os.path.join(d, name + ".png"))


def _open_library(pg, served):
    pg.goto(served + "/?manage")
    pg.wait_for_selector("#library-deep-btn", timeout=15000)


def test_it_sits_beside_check_and_reports_the_failed_book(served, phone):
    pg = phone
    _open_library(pg, served)
    same = pg.evaluate("""() => { var a = document.getElementById('library-health-btn'),
        b = document.getElementById('library-deep-btn');
        return a.parentElement === b.parentElement && a.className === b.className; }""")
    assert same
    _shot(pg, "deep_idle")
    pg.click("#library-deep-btn")
    pg.wait_for_selector("#library-health-section .health-warn", timeout=30000)
    row = pg.inner_text("#library-health-section .health-warn")
    assert "Bad Book" in row and "checksum" in row
    assert "Good Book" not in row
    _shot(pg, "deep_failure")


def test_a_running_check_is_picked_up_with_bytes_book_and_cancel(served, phone):
    pg = phone
    posts = []
    pg.route(
        "**/manage/health",
        lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps(RUNNING)
        ),
    )

    def on_post(route):
        posts.append(route.request.post_data)
        route.fulfill(
            status=200, content_type="application/json", body='{"cancelled": true}'
        )

    pg.route("**/manage/health-check", on_post)
    _open_library(pg, served)  # nothing clicked: the running check is found
    pg.wait_for_selector("#library-health-section .health-deep-progress", timeout=15000)
    text = pg.inner_text("#library-health-section")
    assert "Wikipedia" in text and "12" in text and "40" in text
    assert pg.inner_text("#library-deep-btn") == pg.evaluate("() => t('cancel')")
    _shot(pg, "deep_running")
    pg.on("request", lambda r: r.method == "POST" and r.url.endswith("/manage/health-check") and posts.append(r.post_data))
    pg.click("#library-deep-btn")
    pg.wait_for_timeout(1000)
    assert any(json.loads(p or "{}").get("cancel") is True for p in posts), posts


def test_a_long_check_says_how_long_before_it_starts(served, phone):
    pg = phone
    posts = []

    def on_post(route):
        posts.append(route.request.post_data)
        route.continue_()

    pg.route("**/manage/health-check", on_post)
    _open_library(pg, served)
    pg.evaluate(
        "() => zimsCache.forEach(function (z) { z.size_bytes = 300 * 1024 * 1024 * 1024; })"
    )
    pg.click("#library-deep-btn")
    label = pg.inner_text("#library-deep-btn")
    assert "h" in label and not posts, (label, posts)
