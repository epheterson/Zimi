"""Red, the third theme, in a real browser on a phone's width.

Light, Dark and Red are one choice in Settings; Red is Dark with the night-red class on <html>, kept
under the theme's own key. It has to hold in the shell, in the app pages the reader frame shows, and
over a ZIM's own page (a filter on the frame after the page is darkened), survive a reload, take over
from the old separate switch (zimi.night), and give the old switches (the sky's, the Field Guide's)
one door: choosing the theme.

Run: pytest tests/test_red_theme_browser.py -v
"""

import io
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fieldguide_fixture as fx  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

THEME_KEY = "zimi_app_theme"
BEFORE_KEY = "zimi_app_theme_before_red"
LEGACY_KEY = "zimi.night"
ARTICLE = "/?a=www.ready.gov/www.ready.gov/floods"
# What counts as light that is not red: a green or blue component well above black.
NONRED_MIN = 110
NONRED_SHARE_MAX = 0.002


@pytest.fixture(scope="module")
def pw():
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="module")
def base(pw, tmp_path_factory):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    mp = pytest.MonkeyPatch()
    tmp = tmp_path_factory.mktemp("red")
    zdir = tmp / "zims"
    zdir.mkdir()
    fx.build_library(str(zdir), only=(fx.READY,))
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    mp.setenv("ZIMI_OFFLINE", "1")
    mp.setenv("ZIMI_TORRENT", "0")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


@pytest.fixture
def phone(pw):
    b = pw.chromium.launch()
    ctx = b.new_context(**pw.devices["iPhone 15"], service_workers="block")
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    yield pg
    assert not pg.errors, pg.errors
    ctx.close()
    b.close()


def _open(pg, base, path="/"):
    pg.goto("about:blank")
    pg.goto(base + path, wait_until="domcontentloaded")
    pg.wait_for_function("!document.querySelector('#output .loading')", timeout=30000)


def _is_red(pg):
    return pg.evaluate("document.documentElement.classList.contains('night-red')")


def _nonred_share(pg):
    pil = pytest.importorskip("PIL.Image")
    img = pil.open(io.BytesIO(pg.screenshot())).convert("RGB")
    px = list(img.getdata())
    return sum(1 for (_r, g, b) in px if max(g, b) > NONRED_MIN) / len(px)


def _reader_frame(pg):
    pg.wait_for_function(
        "(() => { var f = document.getElementById('reader-frame'); var d = f && f.contentDocument;"
        " return !!(d && d.body && d.body.textContent.indexOf('floods') >= 0 && f.style.visibility !== 'hidden'); })()",
        timeout=15000,
    )
    return pg.query_selector("#reader-frame")


def test_the_selector_offers_light_dark_red_and_red_holds_across_a_reload(base, phone):
    _open(phone, base, "/?manage=preferences")
    phone.wait_for_selector("#app-theme-seg")
    labels = phone.eval_on_selector_all(
        "#app-theme-seg button", "els => els.map(e => e.innerText.trim())"
    )
    assert labels == ["Auto", "Dark", "Light", "Red"]
    phone.click("#app-theme-seg button:has-text('Red')")
    assert _is_red(phone)
    assert phone.evaluate("localStorage.getItem('%s')" % THEME_KEY) == "red"
    assert (
        phone.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"
    )
    assert (
        phone.evaluate("document.querySelector('meta[name=theme-color]').content")
        == "#000000"
    )
    assert (
        phone.evaluate(
            "document.querySelector('#app-theme-seg .active').innerText.trim()"
        )
        == "Red"
    )
    phone.reload(wait_until="domcontentloaded")
    assert _is_red(phone), "stamped in the head, before the first paint"
    assert (
        phone.evaluate("document.querySelector('meta[name=theme-color]').content")
        == "#000000"
    )
    phone.evaluate("_setAppTheme('light')")
    assert not _is_red(phone)
    assert (
        phone.evaluate("document.documentElement.getAttribute('data-theme')") == "light"
    )
    assert phone.evaluate("document.querySelector('meta[name=theme-color]')") is None


def test_someone_who_had_the_old_red_switch_on_keeps_red_and_what_it_sat_on(
    base, phone
):
    _open(phone, base)
    phone.evaluate(
        "localStorage.setItem('%s', 'light'); localStorage.setItem('%s', 'red')"
        % (THEME_KEY, LEGACY_KEY)
    )
    phone.reload(wait_until="domcontentloaded")
    assert _is_red(phone)
    assert phone.evaluate("localStorage.getItem('%s')" % THEME_KEY) == "red"
    assert phone.evaluate("localStorage.getItem('%s')" % LEGACY_KEY) is None
    # The switch's off goes back to what it replaced.
    phone.evaluate("_nightSet(false)")
    assert phone.evaluate("localStorage.getItem('%s')" % THEME_KEY) == "light"
    assert not _is_red(phone)


def test_the_switches_are_shortcuts_to_the_theme(base, phone):
    _open(phone, base)
    phone.evaluate("_setAppTheme('dark')")
    phone.evaluate("_nightSet(true)")
    assert phone.evaluate("localStorage.getItem('%s')" % THEME_KEY) == "red"
    assert phone.evaluate("localStorage.getItem('%s')" % BEFORE_KEY) == "dark"
    phone.evaluate("_nightToggle()")
    assert phone.evaluate("localStorage.getItem('%s')" % THEME_KEY) == "dark"
    assert not _is_red(phone)


def test_red_holds_over_a_zims_own_page_in_the_reader_frame(base, phone):
    phone.add_init_script("try{localStorage.setItem('%s','red')}catch(e){}" % THEME_KEY)
    _open(phone, base, ARTICLE)
    frame = _reader_frame(phone)
    assert "night-filter" in (frame.get_attribute("class") or "")
    # CSS filter functions, which iOS applies on the frame's GPU layer (an SVG url() filter it drops).
    frame_filter = phone.evaluate(
        "getComputedStyle(document.getElementById('reader-frame')).filter"
    )
    assert "sepia" in frame_filter and "url(" not in frame_filter
    # A plain ZIM page is white and has no dark mode: it was darkened before it was reddened.
    assert phone.evaluate(
        "!!document.getElementById('reader-frame').contentDocument.getElementById('zimi-article-darken')"
    )
    assert _nonred_share(phone) < NONRED_SHARE_MAX
    phone.wait_for_timeout(200)
    # Back to Light: the frame is a plain white page again, no filter.
    phone.evaluate("_setAppTheme('light')")
    assert "night-filter" not in (
        phone.query_selector("#reader-frame").get_attribute("class") or ""
    )


def test_a_page_that_took_red_for_itself_gets_no_filter_over_it(base, phone):
    """ZimiGames draws Red from its own tokens (night-red on its <html>): the reader frame must not dim it again."""
    phone.add_init_script("try{localStorage.setItem('%s','red')}catch(e){}" % THEME_KEY)
    _open(phone, base, ARTICLE)
    frame = _reader_frame(phone)
    assert "night-filter" in (frame.get_attribute("class") or "")
    phone.evaluate("document.getElementById('reader-frame').contentDocument.documentElement.classList.add('night-red')")
    phone.evaluate("_syncFrameNight(null)")
    assert "night-filter" not in (phone.query_selector("#reader-frame").get_attribute("class") or "")
    assert phone.evaluate("_docBroughtRed(document.getElementById('reader-frame').contentDocument)") is True


@pytest.mark.fieldguide_on
def test_red_holds_in_an_app_page_the_reader_frame_shows(base, phone):
    phone.add_init_script("try{localStorage.setItem('%s','red')}catch(e){}" % THEME_KEY)
    _open(phone, base, "/#fieldguide")
    phone.wait_for_function(
        "(() => { var f = document.getElementById('reader-frame'); var d = f && f.contentDocument;"
        " return !!(d && d.documentElement && d.documentElement.classList.contains('night-red')); })()",
        timeout=15000,
    )
    # An app page brings its own Red; a filter over it as well would dim its text to a muddy red.
    assert "night-filter" not in (
        phone.query_selector("#reader-frame").get_attribute("class") or ""
    )
    assert (
        phone.evaluate(
            "getComputedStyle(document.getElementById('reader-frame').contentDocument.body).backgroundColor"
        )
        == "rgb(0, 0, 0)"
    )
    # Turned off from outside the frame, the page follows it.
    phone.evaluate("_setAppTheme('dark')")
    phone.wait_for_function(
        "(() => { var d = document.getElementById('reader-frame').contentDocument;"
        " return !!(d && d.documentElement) && !d.documentElement.classList.contains('night-red'); })()",
        timeout=5000,
    )
