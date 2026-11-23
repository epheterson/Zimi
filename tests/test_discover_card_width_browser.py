"""A Discover card keeps its 260px on a phone, as in the shipping release (it had grown to the row's width at 390px).

Run: pytest tests/test_discover_card_width_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.renderer as renderer  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")


@pytest.mark.parametrize("width", [360, 390, 480])
def test_discover_cards_are_260_on_a_phone(width):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    css = "".join(open(os.path.join(STATIC, n), encoding="utf-8").read() for n in ("tokens.css", "app.css"))
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport={"width": width, "height": 844}, is_mobile=True).new_page()
        page.set_content("<!doctype html><meta name=viewport content='width=device-width'><style>%s</style><body>"
                         "<div class=discover-section><div class=discover-scroll>%s</div></div>"
                         % (css, "<a class=discover-card>x</a>" * 4))
        widths = page.eval_on_selector_all(".discover-card", "els => els.map(e => Math.round(e.getBoundingClientRect().width))")
        b.close()
    assert widths == [260] * 4, widths
