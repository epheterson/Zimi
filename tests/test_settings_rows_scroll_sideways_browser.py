"""Settings' row of panes (Library, Display, Languages, Capture...) and the Manage tabs scroll sideways only: the 44px touch
boxes the pills reach for must not make the rows scrollable up and down too.

Run: pytest tests/test_settings_rows_scroll_sideways_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.renderer as renderer  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")


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


def test_the_rows_have_no_vertical_scroll(phone):
    css = "".join(open(os.path.join(STATIC, n), encoding="utf-8").read() for n in ("tokens.css", "app.css"))
    items = "".join("<button class='%s'>Pane %d</button>" % (c, i) for c, i in (("ms-nav-item", n) for n in range(8)))
    tabs = "".join("<button class='manage-tab'>Tab %d</button>" % n for n in range(8))
    phone.set_content("<!doctype html><meta name=viewport content='width=device-width'><style>%s</style><body>"
                      "<div class=ms-nav id=n>%s</div><div class=manage-tabs id=t>%s</div>" % (css, items, tabs))
    for sel in ("#n", "#t"):
        info = phone.eval_on_selector(sel, "e => [getComputedStyle(e).overflowY, e.scrollWidth > e.clientWidth]")
        assert info == ["hidden", True], (sel, info)
