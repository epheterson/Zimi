"""The Moon's 2048 map waits for the first paint, then comes; the 4096 one waits for the 3D Moon.

app.js paints every Moon from the 54 KB map it fetches as it starts; the
200 KB one is asked for only once the page has painted and gone idle, so it
never competes with the first paint, and a disc as wide as the hero is then
drawn from it. The 730 KB one is the 3D Moon's: a cold open of the Almanac
does not move it. Checked in a real browser against the paint timeline.

Run: pytest tests/test_moon_hires_after_paint.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MID = "earth/moon-2k-v1.webp"
HI = "earth/moon-4k-v1.webp"
LO = "earth/moon-v1.webp"


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
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


TIMELINE = """() => {
  var fcp = performance.getEntriesByName('first-contentful-paint')[0];
  var at = {};
  performance.getEntriesByType('resource').forEach(function (e) {
    var m = e.name.match(/static\\/(earth\\/moon[\\w.-]*)/);
    // The first ask: the Almanac's 3D Moon (almanac-earth.js) asks again later.
    if (m && !(m[1] in at)) at[m[1]] = e.startTime;
  });
  return { fcp: fcp ? fcp.startTime : null, at: at };
}"""


@pytest.mark.parametrize("path", ["/", "/#almanac"])
def test_the_2048_map_is_asked_for_after_first_paint(served, path):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_page(
                viewport={"width": 390, "height": 844}, device_scale_factor=3
            )
            asked = []
            pg.on("request", lambda r: asked.append(r.url))
            pg.goto(served + path, wait_until="load")
            pg.wait_for_function("() => !!_MOON_TEX_MID", timeout=15000)
            tl = pg.evaluate(TIMELINE)
            assert tl["fcp"] is not None, tl
            assert LO in tl["at"] and tl["at"][LO] < tl["fcp"] + 1000, tl
            # Never before the first paint, and asked for after it.
            assert MID in tl["at"], tl
            assert tl["at"][MID] > tl["fcp"], tl
            assert sum(MID in u for u in asked) == 1, asked
            # The 4096 map is not asked for by a page that never opens the 3D Moon.
            pg.wait_for_timeout(3000)
            assert not [u for u in asked if HI in u], asked
            # A disc the hero's size is drawn from it; the Today card's is not.
            assert pg.evaluate("() => _moonMapWidthFor(600)") == 2048
            assert pg.evaluate("() => _moonMapWidthFor(144)") == 256
        finally:
            br.close()
