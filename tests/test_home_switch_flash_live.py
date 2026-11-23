"""The full/compact switch repaints nothing: the library's tiles, cards and the Discover row stay the same elements,
only their classes change ("the whole homepage flashes when I switch between full or compact tiles").

Marks every element on Home, flips the view both ways, and fails if any marked element was removed.

Run: pytest tests/test_home_switch_flash_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

READY = "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0"

MARK = r"""
() => {
  const root = document.getElementById('main-view') || document.body;
  window.__marked = [...root.querySelectorAll('*')];
  return window.__marked.length;
}
"""

GONE = r"""
() => window.__marked.filter(e => !e.isConnected)
  .map(e => (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')).slice(0, 60))
"""

CONTEXTS = {
    "phone": dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2),
    "desktop": dict(viewport={"width": 1280, "height": 800}),
}


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


@pytest.mark.parametrize("kind", sorted(CONTEXTS))
def test_the_view_switch_replaces_no_element(served, kind):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            pg = br.new_context(service_workers="block", **CONTEXTS[kind]).new_page()
            pg.goto(served + "/")
            pg.wait_for_function(READY, timeout=30000)
            pg.wait_for_function("() => { const r = document.getElementById('discover-row'); return r && r.innerHTML.length > 0 && r.dataset.lib; }", timeout=30000)
            pg.wait_for_timeout(1500)
            marked = pg.evaluate(MARK)
            assert marked > 20
            for mode in ("list", "tiles", "list", "tiles"):
                pg.evaluate("(m) => _setLibraryView(m)", mode)
                pg.wait_for_timeout(300)
            gone = pg.evaluate(GONE)
            summary = {}
            for g in gone:
                summary[g] = summary.get(g, 0) + 1
            assert not gone, "the switch replaced %d elements: %r" % (len(gone), sorted(summary.items(), key=lambda kv: -kv[1])[:15])
        finally:
            br.close()
