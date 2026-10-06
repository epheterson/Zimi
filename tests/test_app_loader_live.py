"""An app opens with the loader up until its data is drawn, never blank.

Eric, on his iPhone: "When loading apps it's like fully loaded but blank
screen, pause, then data." The shell's loader went away on the frame's load,
and the app page then sat empty until its first fetch answered. Now the page
says 'ready' once what it opened with is drawn (apps.js), and the loader stays
until then. A slow server is the NAS on a phone: the server holds the app's
data back so the gap, if any, is wide enough to see.

Run: pytest tests/test_app_loader_live.py -v
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# How long the app's own data is held back.
DATA_DELAY_S = 1.2
# A sample: is the loader gone, and has ZimiTube drawn any words yet (its
# chrome is icons; before its data it has no text at all).
PROBE = """() => { var l = document.getElementById('reader-loading');
  var f = document.getElementById('reader-frame'), words = 0;
  try { words = f.contentDocument.body.innerText.trim().length; } catch (e) {}
  return { gone: !!l && l.classList.contains('hidden'), words: words,
           app: !!(f && f.contentWindow && f.contentWindow.location.pathname === '/static/tube.html') }; }"""


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

    class SlowData(ZimHandler):
        # The app's own data, held back as a far server would.
        def do_GET(self):
            if self.path.startswith(("/tube?", "/tube/")):
                time.sleep(DATA_DELAY_S)
            return super().do_GET()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), SlowData)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def test_tube_never_shows_blank_between_loader_and_data(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(**p.devices["iPhone 13"])
        pg = ctx.new_page()
        pg.goto(served + "/#tube")
        blank, drawn = [], False
        deadline = time.time() + DATA_DELAY_S * 5
        while time.time() < deadline and not drawn:
            s = pg.evaluate(PROBE)
            if s["app"] and s["gone"] and not s["words"]:
                blank.append(s)
            drawn = s["gone"] and s["words"] > 0
            time.sleep(0.05)
        br.close()
    assert drawn, "ZimiTube never drew its talks"
    assert not blank, "the loader went away %d samples before the data" % len(blank)
