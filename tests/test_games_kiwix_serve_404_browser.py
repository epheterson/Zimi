"""The catalog's Games ZIM under kiwix-serve (pages at /content/<zim>/): the shelf and a game load every file they ask for and
never ask for Zimi's /games-day. The ZIM carries Zimi's footer files, as the built-in one does.

Run: pytest tests/test_games_kiwix_serve_404_browser.py -v
"""

import http.server
import os
import sys
import tempfile
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from games_wait import shell_ready  # noqa: E402

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

PREFIX = "/content/zimi_mul_games/"


def test_the_catalog_build_stages_zimis_footer():
    import build_games_kiwix  # noqa: F401
    from zimi import ownzims

    with tempfile.TemporaryDirectory() as tmp:
        ownzims._stage_games(tmp)
        assert os.path.isfile(os.path.join(tmp, "zimifooter.js")) and os.path.isfile(os.path.join(tmp, "zimifooter.css"))
    src = open(os.path.join(ROOT, "scripts", "build_games_kiwix.py"), encoding="utf-8").read()
    assert "_stage_games(" in src and "copytree" not in src


@pytest.fixture(scope="module")
def kiwix_like():
    """Like kiwix-serve: pages under /content/<zim>/, a 404 for anything else (no Zimi routes). The staged folder is what the ZIM holds."""
    from zimi import ownzims

    with tempfile.TemporaryDirectory() as tmp:
        ownzims._stage_games(tmp)
        with open(os.path.join(tmp, ownzims.BUILD_FILE), "w") as f:   # the build adds it to the ZIM (with_build_year)
            f.write("window.ZIMI_BUILT_YEAR = 2026;\n")
        asked = []

        class H(http.server.SimpleHTTPRequestHandler):
            def translate_path(self, path):
                asked.append(path)
                if not path.startswith(PREFIX):
                    return os.path.join(tmp, "__missing__")
                return super().translate_path("/" + path[len(PREFIX):])

            def log_message(self, *a, **k):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: H(*a, directory=tmp, **k))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        yield "http://127.0.0.1:%d" % srv.server_address[1], asked
        srv.shutdown()


@pytest.mark.parametrize("page_name", ["index.html", "chess.html"])
def test_no_missing_file_and_no_games_day(kiwix_like, page_name):
    base, asked = kiwix_like
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        page = b.new_page()
        missing = []
        page.on("response", lambda r: missing.append(r.url) if r.status >= 400 else None)
        page.goto(base + PREFIX + page_name)
        if page_name != "index.html":
            shell_ready(page)
        page.wait_for_load_state("networkidle")
        b.close()
    assert not missing, missing
    assert not [a for a in asked if a.startswith("/games-day")], asked
