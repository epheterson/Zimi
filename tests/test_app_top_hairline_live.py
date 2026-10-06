"""No light line along the top of an app once the header has slid away.

Eric, on his iPhone: "I get a white horizontal hairline drawn at the top of
apps after scrolling sometimes." Two things could draw it, and both are held
here, in both themes:
- the reader frame's own background was a ZIM page's white under every app
  page too, so whatever of the frame showed past the page (iOS's bounce at the
  top, a part pixel while the header slides) was white;
- the header slid up by exactly its height, so a part pixel of rounding left
  its bottom border along the top of the screen.

Run: pytest tests/test_app_top_hairline_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STATE = """() => { var f = document.getElementById('reader-frame');
  var probe = document.createElement('div'); probe.style.background = 'var(--bg)';
  document.body.appendChild(probe); var bg = getComputedStyle(probe).backgroundColor; probe.remove();
  return { app: document.body.classList.contains('app-page'),
           away: document.body.classList.contains('chrome-away'),
           frameBg: getComputedStyle(f).backgroundColor, bg: bg,
           topbarBottom: document.querySelector('.topbar').getBoundingClientRect().bottom }; }"""


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim, build_media_fixture_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_media_fixture_zim(str(zdir / "media.zim"))
    build_fixture_zim(str(zdir / "water.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_nothing_light_shows_above_an_app(served, scheme):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(**p.devices["iPhone 13"], color_scheme=scheme)
        pg = ctx.new_page()
        pg.goto(served + "/#tube")
        pg.wait_for_function(
            "() => document.body.classList.contains('app-page')", timeout=15000
        )
        pg.wait_for_function(
            "() => document.getElementById('reader-loading').classList.contains('hidden')",
            timeout=15000,
        )
        s = pg.evaluate(STATE)
        assert s["frameBg"] == s["bg"], s
        # Over an app the header steps aside only when held (a video playing
        # sideways), and stays while focus is in it, so nothing is focused.
        pg.evaluate("() => { document.activeElement.blur(); _chromeImmersive(true); }")
        pg.wait_for_timeout(400)  # past the slide
        s = pg.evaluate(STATE)
        assert s["away"], s
        assert s["topbarBottom"] <= -1, s
        br.close()
