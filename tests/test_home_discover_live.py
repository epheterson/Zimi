"""Discover's switch and the home page's counts, on a 390px phone.

Eric, 2026-09-30 (1.12.1):
- Turning Discover off in Settings > Preferences sent him to the home page.
  Settings and home paint into the same #output, and the switch drew home.
- With Discover off, the counts line moved to the top and sat squeezed over
  the Apps row: "with it off we need better spacing here or just always
  that at the bottom now if apps are at the top?" The counts close the
  page, Discover on or off, and the Apps row leads it.

Run: pytest tests/test_home_discover_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

READY = "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0"


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from app_saved_fixture import build_library

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    build_library(zdir)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _phone(pw):
    br = pw.chromium.launch()
    return (
        br,
        br.new_context(**pw.devices["iPhone 13"], service_workers="block").new_page(),
    )


def test_the_discover_switch_leaves_settings_where_it_is(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _phone(pw)
        try:
            pg.goto(served + "/")
            pg.wait_for_function(READY, timeout=30000)
            pg.evaluate("() => enterManage(null, 'preferences')")
            pg.wait_for_selector("#ms-show-discover", state="attached")
            row = pg.locator("label:has(#ms-show-discover)")
            row.scroll_into_view_if_needed()
            row.click()
            pg.wait_for_timeout(400)
            assert (
                pg.evaluate("() => localStorage.getItem('zimi_hide_discover')") == "1"
            )
            assert pg.evaluate("() => mode") == "manage"
            assert (
                pg.locator("#ms-show-discover").count() == 1
            ), "Settings was replaced by the home page"
            assert not pg.locator("#ms-show-discover").is_checked()
            assert pg.locator("#output .app-tile, #discover-row").count() == 0
            row.click()  # and back on, still in Settings
            pg.wait_for_timeout(400)
            assert (
                pg.evaluate("() => localStorage.getItem('zimi_hide_discover')") is None
            )
            assert pg.locator("#ms-show-discover").is_checked()
            # Home, when it is shown next, has Discover again.
            pg.evaluate("() => enterHome(true)")
            pg.wait_for_timeout(400)
            assert pg.locator("#output #discover-row").count() == 1
        finally:
            br.close()


@pytest.mark.parametrize("discover", ["on", "off"])
def test_the_counts_close_home_and_the_apps_lead_it(served, discover):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _phone(pw)
        try:
            pg.goto(served + "/")
            if discover == "off":
                pg.evaluate("() => localStorage.setItem('zimi_hide_discover', '1')")
                pg.reload()
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_timeout(500)
            assert (
                pg.evaluate(
                    "() => getComputedStyle(document.getElementById('stats-bar')).display"
                )
                == "none"
            ), "no counts over the page"
            last = pg.evaluate(
                "() => { var k = [...document.getElementById('output').children].filter(e => e.offsetHeight > 0); return k[k.length - 1].className + '|' + k[k.length - 1].textContent; }"
            )
            assert last.startswith("stats-bar|") and "sources" in last, last
            first = pg.evaluate(
                "() => { var k = [...document.getElementById('output').children].filter(e => e.offsetHeight > 0); return k[0].id || k[0].className; }"
            )
            assert first != "stats-bar", first
            if discover == "off":
                # The Apps heading is the first thing under the top bar, at the
                # page's own top padding, not pushed down by a counts line.
                gap = pg.evaluate(
                    "() => document.querySelector('#output .cat-heading').getBoundingClientRect().top - document.querySelector('.topbar').getBoundingClientRect().bottom"
                )
                assert gap < 40, gap
        finally:
            br.close()


def _silence_wav(seconds=1.0, rate=8000):
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


QUOTE = (
    "Imagination is more important than knowledge. For knowledge is limited,"
    " whereas imagination embraces the entire world."
)


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_the_quote_card_says_its_quote_and_stays(served, scheme):
    """Eric, 2026-10-03: "What if we also offered speaking the quote of the
    day to hear it with more impact!?" The quote card's Say asks for the
    quote alone (not who said it) as a sentence in the Wikiquote's
    language, pulses while it plays, and is not a tap on the card."""
    from urllib.parse import parse_qs, urlparse

    from playwright.sync_api import sync_playwright

    wav = _silence_wav()
    asked = []

    def speak(route):
        asked.append(route.request.url)
        route.fulfill(status=200, body=wav, headers={"Content-Type": "audio/wav"})

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(
            **pw.devices["iPhone 13"], service_workers="block", color_scheme=scheme
        ).new_page()
        try:
            pg.route("**/dictionary/speak?*", speak)
            pg.goto(served + "/")
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_selector("#discover-row", state="attached")
            # Discover's own cards in first, so they do not paint over ours.
            pg.wait_for_function(
                "() => document.querySelector('#discover-row .discover-card') && !document.querySelector('#discover-row .dc-loading')",
                timeout=20000,
            )
            pg.wait_for_timeout(500)
            pg.evaluate(
                """q => _renderDiscover(document.getElementById('discover-row'), [{
                  zim: 'wikiquote_de_all_nopic_2026-01', path: 'Albert_Einstein',
                  title: 'Albert Einstein', blurb: '\\u201c' + q + '\\u201d',
                  attribution: 'Albert Einstein' }])""",
                QUOTE,
            )
            say = pg.locator(".dc-quote-card .dc-say")
            assert say.count() == 1
            say.scroll_into_view_if_needed()
            if os.environ.get("ZIMI_SHOTS"):
                pg.locator(".dc-quote-card").screenshot(
                    path=os.path.join(
                        os.environ["ZIMI_SHOTS"], "discover-quote-say-%s.png" % scheme
                    )
                )
            where = pg.url
            say.click()
            pg.wait_for_function("() => !!document.querySelector('.dc-say.on')")
            assert asked, "Say asked the server for nothing"
            got = parse_qs(urlparse(asked[-1]).query)
            assert got["text"] == [QUOTE]
            assert got["lang"] == ["de"] and got["kind"] == ["sentence"]
            pg.wait_for_timeout(300)
            assert pg.url == where and pg.evaluate("() => mode") != "reader"
            box = pg.locator(".dc-quote-card").bounding_box()
            assert box["x"] >= 0 and box["x"] + box["width"] <= 390
        finally:
            br.close()
