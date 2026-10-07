"""The first-run setup page in a real browser (#107).

A fresh install that other devices can reach opens on "who can change
settings" and nothing else. In headless Chromium at a phone's width, against
the shipped files:

  1. A device on the network, through a proxy, is asked for the setup key and
     held to a password (no password from behind a proxy would lock it out).
     With the key and a password it lands in the library, signed in.
  2. A visitor from the internet sees only that Zimi is being set up: no
     field, nothing to guess at.
  3. The passwords must match before anything is sent.

The server's side, every state and refusal, is in test_first_run_access.py.

Run: pytest tests/test_first_run_setup_browser.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

VIEW = {"width": 390, "height": 844}
LAN_VIA_PROXY = {"X-Forwarded-For": "192.168.1.50"}
INTERNET = {"X-Forwarded-For": "8.8.8.8"}


@pytest.fixture()
def served(tmp_path):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi import manage
    from zimi.http import ZimHandler

    (tmp_path / "zims").mkdir()
    (tmp_path / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp_path / "zims"), str(tmp_path / "data")
    for k in (
        "ZIMI_MANAGE_PASSWORD",
        "ZIMI_LAN_ADMIN",
        "ZIMI_MANAGE_OPEN",
        "ZIMI_MANAGE_EXTERNAL",
    ):
        os.environ.pop(k, None)
    manage._env_pw_hash_cache = None
    srv.load_cache(force=True)
    assert manage.init_setup_gate("0.0.0.0"), "a fresh reachable install waits"
    key = manage.ensure_setup_key()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], key
    httpd.shutdown()
    manage._setup_gate = False
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.fixture()
def browser(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        yield br
        br.close()


def _page(browser, base, headers):
    ctx = browser.new_context(viewport=VIEW, extra_http_headers=headers)
    page = ctx.new_page()
    page.goto(base)
    page.wait_for_selector("#setup-overlay.open")
    return page


def test_a_device_on_the_network_sets_it_up_with_the_key(served, browser):
    base, key = served
    page = _page(browser, base, LAN_VIA_PROXY)
    assert page.is_visible("#setup-key")
    assert page.is_disabled("#setup-req"), "a password is held on through a proxy"
    assert page.get_attribute("#setup-user", "autocomplete") == "username"
    assert page.get_attribute("#setup-user", "placeholder") == "admin"
    page.fill("#setup-key", key)
    page.fill("#setup-pw", "hunter22")
    page.fill("#setup-pw2", "hunter22")
    page.click("#setup-form button[type=submit]")
    page.wait_for_load_state("load")
    page.wait_for_function(
        "!document.getElementById('setup-overlay').classList.contains('open')"
    )
    assert page.evaluate("fetch('/list').then(r => r.status)") == 200
    assert (
        page.evaluate(
            "fetch('/manage/has-password').then(r => r.json()).then(j => j.access)"
        )
        == "password"
    )


def test_the_internet_sees_only_that_it_is_being_set_up(served, browser):
    base, _ = served
    page = _page(browser, base, INTERNET)
    assert page.query_selector("#setup-form") is None
    assert page.query_selector("#setup-card input") is None


def test_the_passwords_must_match(served, browser):
    base, key = served
    page = _page(browser, base, LAN_VIA_PROXY)
    page.fill("#setup-key", key)
    page.fill("#setup-pw", "hunter22")
    page.fill("#setup-pw2", "hunter23")
    page.click("#setup-form button[type=submit]")
    assert page.is_visible("#setup-error")
    assert (
        page.evaluate(
            "fetch('/manage/has-password').then(r => r.json()).then(j => j.setup)"
        )
        is True
    )
