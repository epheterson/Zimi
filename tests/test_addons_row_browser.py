"""Settings > Server > Add-ons row: every state is one row shape, and a second press cannot start a second install.

/manage/addons is answered by the test (no add-on is fetched). Run: pytest tests/test_addons_row_browser.py -v
"""

import json
import os
import sys
import threading

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import zimi.server as srv  # noqa: E402
from conftest_zim import build_fixture_zim  # noqa: E402
from zimi import http  # noqa: E402

PHONE = {"width": 390, "height": 844}


@pytest.fixture
def base(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setenv("ZIMI_TORRENT", "0")
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "wikipedia_en_all_2026-10.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), http.ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _row(key, **kw):
    r = {"key": key, "size": 50_000_000, "ready": False, "own": False, "requires": []}
    r.update(kw)
    return r


class Fake:
    """The add-ons endpoint: the rows are set by the test, installs are counted."""

    def __init__(self, rows):
        self.rows = rows
        self.posts = []
        self.busy = False

    def status(self):
        return {
            "supported": True,
            "mode": "ask",
            "locked": False,
            "env": "ZIMI_ADDONS",
            "choices": ["ask", "auto", "never"],
            "addons": self.rows,
            "delegated": [],
        }

    def handle(self, route):
        req = route.request
        if req.method == "POST":
            body = json.loads(req.post_data or "{}")
            self.posts.append(body)
            if body.get("install"):
                if self.busy:
                    return route.fulfill(
                        status=409,
                        content_type="application/json",
                        body='{"error":"busy"}',
                    )
                self.busy = True
                for r in self.rows:
                    if r["key"] == body["install"]:
                        r["progress"] = {
                            "done": 10,
                            "total": 100,
                            "step": "",
                            "active": True,
                            "error": None,
                        }
        route.fulfill(
            status=200, content_type="application/json", body=json.dumps(self.status())
        )


def _open(pw, base, fake, scheme="dark", viewport=PHONE):
    br = pw.chromium.launch()
    pg = br.new_context(
        viewport=viewport, color_scheme=scheme, service_workers="block"
    ).new_page()
    pg.route("**/manage/addons", fake.handle)
    pg.goto(base + "/")
    pg.wait_for_selector("#q")
    pg.evaluate(
        "() => { var o = document.getElementById('setup-overlay'); if (o) o.remove(); }"
    )
    pg.evaluate("() => enterManage(null, 'library')")
    pg.wait_for_selector("#ms-addons", state="attached", timeout=30000)
    pg.evaluate("() => { document.querySelector('.offline-fold').open = true; }")
    return br, pg


def _paint(pg, **opts):
    pg.evaluate(
        "(o) => { _addonsOpts = Object.assign({host: 'ms-addons'}, o); return _renderAddons(_addonsOpts); }",
        opts,
    )


def test_a_second_press_does_not_start_a_second_install(base):
    from playwright.sync_api import sync_playwright

    fake = Fake([_row("video", own=True, ready=True), _row("browser")])
    with sync_playwright() as pw:
        br, pg = _open(pw, base, fake)
        _paint(pg, setup=True)
        pg.wait_for_selector("#ms-addons [data-addon=browser] button")
        # Two presses in the same tick, the way a double tap lands.
        pg.evaluate(
            "() => { var b = document.querySelector('[data-addon=browser] button'); b.click(); b.click(); _addonInstall('browser'); }"
        )
        pg.wait_for_selector("[data-addon=browser][data-state=downloading]")
        assert [p for p in fake.posts if p.get("install")] == [{"install": "browser"}]
        br.close()


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_every_state_is_the_same_row_shape(base, scheme):
    from playwright.sync_api import sync_playwright

    live = {"done": 40, "total": 100, "step": "", "active": True, "error": None}
    cases = {
        "idle": _row("browser"),
        "downloading": _row("browser", progress=dict(live)),
        "installing": _row("browser", progress=dict(live, step="build")),
        "cancelling": _row("browser", progress=dict(live, cancelling=True)),
        "ready": _row("browser", own=True, ready=True),
        "failed": _row(
            "browser", progress=dict(live, active=False, error="OSError: x")
        ),
    }
    heights = {}
    with sync_playwright() as pw:
        for state, row in cases.items():
            fake = Fake([row])
            br, pg = _open(pw, base, fake, scheme)
            _paint(pg, setup=state != "ready")
            pg.wait_for_selector("#ms-addons [data-addon=browser]")
            assert pg.get_attribute("[data-addon=browser]", "data-state") == state
            assert "addon_" not in pg.inner_text("#ms-addons")
            heights[state] = pg.evaluate(
                "() => document.querySelector('[data-addon=browser]').getBoundingClientRect().height"
            )
            assert pg.evaluate(
                "() => document.documentElement.scrollWidth <= innerWidth"
            )
            br.close()
    assert max(heights.values()) - min(heights.values()) <= 1, heights
