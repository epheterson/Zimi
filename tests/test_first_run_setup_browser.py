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


def test_turning_off_the_password_is_one_named_press(served, browser):
    """Anyone, anywhere: its cost shows only while it is being chosen, and the
    button that saves it is the confirmation; no second switch to tick, and
    once on only the switch's own line remains."""
    base, _ = served
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto(base)
    tok = page.evaluate(
        """() => fetch('/manage/access', {method: 'POST', headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({external: true, require_password: true, username: 'admin',
                                   password: 'hunter22', remember: true})})
           .then(r => r.json()).then(j => j.token)"""
    )
    page.evaluate("t => localStorage.setItem('zimi_manage_token', t)", tok)
    page.goto(base + "/?manage=users")
    page.wait_for_selector("#setup-req", state="attached", timeout=15000)
    assert page.is_hidden("#setup-open")
    page.wait_for_selector(".ms-user-account-self #setup-user", timeout=15000)
    assert page.locator("#setup-form #setup-user").count() == 0, "the name is Your account's"
    page.locator("#setup-req").evaluate("e => e.click()")
    assert page.is_visible("#setup-open")
    assert page.locator("#setup-open input").count() == 0, "no switch to tick"
    assert page.inner_text("#setup-save button") == "Turn off password"
    page.fill("#setup-cur-pw", "hunter22")
    page.click("#setup-save button")
    page.wait_for_function(
        "fetch('/manage/has-password').then(r => r.json()).then(j => j.access === 'open')"
    )
    page.wait_for_selector("#setup-open", state="hidden")
    assert page.is_hidden("#setup-save")
    desc = page.locator("#setup-req").locator("xpath=ancestor::*[contains(@class,'share-row')][1]")
    assert "can manage Zimi" in desc.inner_text()
    assert page.locator("#ms-users-body").inner_text().strip() == "", "no accounts to edit while open"
    assert page.is_visible("#ms-security")


def _signed_in_access(browser, base, username):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto(base)
    tok = page.evaluate(
        """u => fetch('/manage/access', {method: 'POST', headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({external: true, require_password: true, username: u,
                                   password: 'hunter22', remember: true})})
           .then(r => r.json()).then(j => j.token)""",
        username,
    )
    page.evaluate("t => localStorage.setItem('zimi_manage_token', t)", tok)
    page.goto(base + "/?manage=users")
    page.wait_for_selector(".ms-user-account-self #setup-user", timeout=15000)
    return page


def test_a_switch_does_not_name_an_unnamed_account(served, browser):
    """No username stored: Your account shows "admin", and flipping a switch
    must not save that as the name (it would change how the password logs in)."""
    from zimi import manage

    base, _ = served
    page = _signed_in_access(browser, base, "")
    assert page.input_value("#setup-user") == "admin"
    page.locator("#setup-ext").evaluate("e => e.click()")
    page.wait_for_function(
        "fetch('/manage/has-password').then(r => r.json()).then(j => j.external === false)"
    )
    assert manage._get_manage_user() == ""


def test_open_with_no_kept_password_says_how_out(served, browser):
    """Anyone, anywhere chosen from the network alone has no password to go
    back to: the password switch is held, with the way out on its line."""
    base, _ = served
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto(base)
    for body in ('{"external": false, "require_password": false}',
                 '{"external": true, "require_password": false, "open_confirm": true}'):
        page.evaluate(
            "b => fetch('/manage/access', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: b})",
            body,
        )
    page.goto(base + "/?manage=users")
    page.wait_for_selector("#setup-req", state="attached", timeout=15000)
    assert page.is_disabled("#setup-req")
    row = page.locator("#setup-req").locator("xpath=ancestor::*[contains(@class,'share-row')][1]")
    assert "first turn off Allow managing from outside" in row.inner_text()
