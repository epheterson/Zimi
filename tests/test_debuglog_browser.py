"""The debug log, in a real page: server off, the page fetches and sends nothing; server on, a tap and a script
error land in the server's file, and switching it off live stops the recorder.

Run: pytest tests/test_debuglog_browser.py -v
"""

import json
import os
import sys
import threading
import time
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import debuglog, manage, users  # noqa: E402


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    import zimi.server as srv
    from zimi.http import ZimHandler

    (tmp_path / "zims").mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path / "zims"))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(debuglog.ENV, raising=False)
    monkeypatch.setattr(users, "request_data_owner", lambda handler: "alice")
    manage._prefs_cache.clear()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], tmp_path
    httpd.shutdown()


def _lines(tmp):
    p = tmp / "debug" / debuglog.FILE
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()] if p.exists() else []


def _wait(cond, secs=20):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.2)
    return False


def _open(pw, url, seen):
    br = pw.chromium.launch()
    ctx = br.new_context(
        viewport={"width": 390, "height": 844}, service_workers="block"
    )
    pg = ctx.new_page()
    pg.on("request", lambda r: seen.append((r.method, r.url)))
    pg.goto(url + "/", wait_until="load")
    return br, pg


def test_off_sends_nothing_and_loads_nothing(served):
    from playwright.sync_api import sync_playwright

    url, tmp = served
    seen = []
    with sync_playwright() as pw:
        br, pg = _open(pw, url, seen)
        try:
            pg.wait_for_timeout(3000)  # the stream's first tick has said "off"
            pg.mouse.click(20, 20)
            pg.wait_for_timeout(1500)
            assert pg.evaluate("() => typeof _dbl") == "undefined"
            assert not any("debuglog" in u for _, u in seen), seen
        finally:
            br.close()
    assert not (tmp / "debug").exists()


def test_on_a_tap_and_an_error_reach_the_file_and_off_stops_it(served, monkeypatch):
    from playwright.sync_api import sync_playwright

    url, tmp = served
    monkeypatch.setenv(debuglog.ENV, "1")
    seen = []
    with sync_playwright() as pw:
        br, pg = _open(pw, url, seen)
        try:
            pg.wait_for_function(
                "() => typeof _dbl !== 'undefined' && _dbl.on", timeout=30000
            )
            pg.evaluate(
                "() => { var b = document.createElement('button'); b.id = 'dbl-probe'; b.textContent = 'Probe me'; b.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999;width:120px;height:40px'; document.body.appendChild(b); }"
            )
            pg.click("#dbl-probe")
            pg.evaluate("() => setTimeout(() => { throw new Error('probe boom'); }, 0)")
            pg.wait_for_timeout(300)
            pg.evaluate("() => _dbl.flush(false)")
            assert _wait(
                lambda: any(
                    g["k"] == "tap" and "dbl-probe" in g.get("el", "")
                    for g in _lines(tmp)
                )
            ), _lines(tmp)[-5:]
            got = _lines(tmp)
            tap = next(g for g in got if g["k"] == "tap" and "dbl-probe" in g["el"])
            assert (
                'button#dbl-probe "Probe me"' in tap["el"]
                and tap["user"] == "alice"
                and tap["client"]
            )
            assert any(g["k"] == "error" and "probe boom" in g["msg"] for g in got)
            assert any(g["k"] == "start" for g in got)
            # an input's value is never recorded
            pg.evaluate(
                "() => { var i = document.createElement('input'); i.type = 'password'; i.id = 'dbl-pw'; i.value = 'hunter2'; i.style.cssText = 'position:fixed;left:10px;top:70px;z-index:99999'; document.body.appendChild(i); }"
            )
            pg.click("#dbl-pw")
            pg.evaluate("() => _dbl.flush(false)")
            assert _wait(lambda: any("dbl-pw" in g.get("el", "") for g in _lines(tmp)))
            assert "hunter2" not in (tmp / "debug" / debuglog.FILE).read_text(encoding="utf-8")
            # a tapped panel that merely has an id is named, never read: a token shown in it stays out of the log
            pg.evaluate(
                "() => { var d = document.createElement('div'); d.id = 'dbl-panel'; d.innerHTML = '<span>tok-s3cret-value</span>'; d.style.cssText = 'position:fixed;left:10px;top:120px;z-index:99999;width:200px;height:40px;background:#fff'; document.body.appendChild(d); }"
            )
            pg.click("#dbl-panel span")
            pg.evaluate("() => _dbl.flush(false)")
            assert _wait(lambda: any("dbl-panel" in g.get("el", "") for g in _lines(tmp)))
            assert "tok-s3cret-value" not in (tmp / "debug" / debuglog.FILE).read_text(encoding="utf-8")
            # switched off in Manage's way: the server stops keeping it and the window stops recording
            monkeypatch.delenv(debuglog.ENV)
            assert debuglog.set_enabled(False)
            assert _wait(
                lambda: pg.evaluate("() => _dbl.on") is False, 10
            ), "the window heard it is off"
            before = len(_lines(tmp))
            pg.click("#dbl-probe")
            pg.wait_for_timeout(500)
            assert len(_lines(tmp)) == before
        finally:
            br.close()
