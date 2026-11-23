"""A control drawn under 44px still takes a 44px touch (an invisible box, nothing drawn or laid out moves).
Measured the way a finger finds it: elementFromPoint outward from the control until another element answers.

Run: pytest tests/test_hit_areas_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.renderer as renderer  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")
TARGET = 44
SLACK = 2  # a hairline border does not take a touch; a box edge on a fractional pixel (a narrower font) loses up to one at each end of a probe stepped in whole pixels

REACH_JS = """(el) => {
  const r = el.getBoundingClientRect();
  const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e)); };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const run = (fx, fy) => { let n = 0; while (n < 40 && hit(fx(n + 1), fy(n + 1))) n++; return n; };
  const l = run(n => r.left - n, () => cy), rt = run(n => r.right + n, () => cy);
  const t = run(() => cx, n => r.top - n), b = run(() => cx, n => r.bottom + n);
  return [Math.round(r.width + l + rt), Math.round(r.height + t + b), Math.round(r.width), Math.round(r.height)];
}"""


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def phone():
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        yield ctx.new_page()
        b.close()


def _shell(phone, body):
    css = _read("tokens.css") + _read("app.css")
    phone.set_content("<!doctype html><meta name=viewport content='width=device-width'><style>%s</style><body>%s" % (css, body))


def _reach(phone, selector):
    return phone.eval_on_selector(selector, REACH_JS)


def test_a_pill_in_the_scrolling_row_reaches_44_tall(phone):
    _shell(phone, "<div style='padding:40px 16px 0'><div class=pills-row><button class='pill active'>All</button>"
                  "<button class=pill>Wikipedia (9)</button></div></div><p style='margin-top:20px'>after</p>")
    w, h, dw, dh = _reach(phone, ".pill")
    assert dh == 28 and h >= TARGET - SLACK, (w, h)


def test_the_pill_row_does_not_move(phone):
    html = "<div style='padding:40px 16px 0'><div id=r class=pills-row><button class=pill>All</button></div></div><p id=a>after</p>"
    _shell(phone, html)
    after = phone.evaluate("[r.getBoundingClientRect().top, a.getBoundingClientRect().top, r.getBoundingClientRect().height]")
    phone.set_content("<style>%s</style><body>%s" % (_read("tokens.css") + _read("app.css").replace(
        ".pills-row { padding-block: 8px 10px; margin-block: -8px; }", ""), html))
    before = phone.evaluate("[r.getBoundingClientRect().top, a.getBoundingClientRect().top, r.getBoundingClientRect().height]")
    assert after[1] == before[1], (before, after)


def test_hide_discover_reaches_44_tall(phone):
    _shell(phone, "<div class=discover-section style='padding:60px 16px 0'><div class=discover-label style='display:flex;justify-content:space-between'>"
                  "<span>Discover</span><button class=dc-dismiss>x</button></div></div>")
    w, h, dw, dh = _reach(phone, ".dc-dismiss")
    assert dh < 20 and h >= TARGET - SLACK and w >= TARGET - SLACK, (w, h)


def _app_page(phone, body):
    css = _read("tokens.css") + _read("apps.css")
    phone.set_content("<!doctype html><meta name=viewport content='width=device-width'><style>%s</style><body>%s" % (css, body))


def test_an_app_chip_is_the_shells_pill_and_reaches_44(phone):
    """Bookshelf and ZimiTube's chip: 28 tall and 12px like Home's pill, the chosen one filled amber, a 44px touch."""
    _app_page(phone, "<div class=page><div class=chips><button class='chip on'>Shelf</button><button class=chip>Authors</button></div></div>")
    w, h, dw, dh = _reach(phone, ".chip.on")
    assert dh == 28 and h >= TARGET - SLACK, (h, dh)
    style = "e => { const c = getComputedStyle(e); return [c.fontSize, c.borderRadius, c.fontWeight, c.backgroundImage.slice(0, 15)]; }"
    assert phone.eval_on_selector(".chip.on", style) == ["12px", "20px", "600", "linear-gradient"]
    assert phone.eval_on_selector(".chip:not(.on)", style)[:3] == ["12px", "20px", "500"]


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    import threading
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("hitareas")
    (tmp / "zims").mkdir()
    (tmp / "data").mkdir()
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old


@pytest.mark.parametrize("path, selectors", [
    ("/", ["#logo", "#search-help", "#library-btn", "#bm-panel-btn", ".topbar-more"]),
    ("/?q=Paris", ["#logo", "#back-btn", "#search-clear", "#library-btn", "#bm-panel-btn", ".topbar-more"]),  # tips wait while a query is typed
])
def test_the_top_bar_reaches_44_where_it_can(phone, served, path, selectors):
    """The bar's controls on a phone, as a finger finds them: every one 44 wide and tall. With a query typed the tips mark waits
    (it is on the empty box), so the clear x has the end to itself."""
    phone.goto(served + path)
    phone.wait_for_selector(".topbar .logo")
    phone.wait_for_timeout(500)
    for sel in selectors:
        w, h, dw, dh = _reach(phone, sel)
        assert h >= TARGET - SLACK and w >= TARGET - SLACK, (sel, w, h)
    if path != "/":
        assert phone.eval_on_selector("#search-help", "e => getComputedStyle(e).display") == "none"


def test_two_stacked_pill_rows_each_reach_44(phone):
    """The source row over the language row (.suggest-filters): centres 44 apart, so neither row loses its touch to the other."""
    _shell(phone, "<div style='padding:40px 16px 0'><div class=suggest-filters style='padding:8px 0;border:0'>"
                  "<div class=pills-row><button class='pill active'>All</button><button class=pill>Wikipedia (9)</button></div>"
                  "<div class=lang-pills><button class='pill active'>All</button><button class=pill>English (9)</button></div></div></div>")
    for sel in (".pills-row .pill", ".lang-pills .pill"):
        w, h, dw, dh = _reach(phone, sel)
        assert h >= TARGET - SLACK, (sel, h)
