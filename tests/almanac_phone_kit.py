"""A served Zimi and a software-GL Chromium at a phone's size, shared by the Almanac's small phone-width row tests."""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from browser_slots import WEBGL_ARGS

GL_ARGS = os.environ.get(
    "LAUNCHES_GL_ARGS",
    " ".join(WEBGL_ARGS),
).split()
VIEW = {"width": 390, "height": 844}
READY_MS = 400_000


@pytest.fixture(scope="module")
def browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        yield br
        br.close()


@pytest.fixture
def served(tmp_path):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    (tmp_path / "zims").mkdir()
    (tmp_path / "data").mkdir()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp_path / "zims"), str(tmp_path / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old
