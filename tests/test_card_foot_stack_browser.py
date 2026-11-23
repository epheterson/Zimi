"""A wide row's marks (favorite, kept on this phone, whatever comes next) stack up its right edge with the one control, the
three dots, at the bottom. Tiles keep their foot as it was.

Run: pytest tests/test_card_foot_stack_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.renderer as renderer  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")

CARD = ("<a class='stat-card'><div class='card-icon'>W</div><div class='card-info'><div class='name'>Wikipedia</div>"
        "<div class='desc'>An encyclopedia</div><div class='detail'>2 entries</div></div>"
        "<span class='card-foot'><span class='card-marks'><i class='fav-mark'>*</i><i class='keep-ico'>k</i><i class='x-mark'>x</i></span>"
        "<button class='card-more'>...</button></span></a>")


def _boxes(width, grid_class):
    from playwright.sync_api import sync_playwright

    css = "".join(open(os.path.join(STATIC, n), encoding="utf-8").read() for n in ("tokens.css", "app.css"))
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport={"width": width, "height": 844}, is_mobile=True).new_page()
        page.set_content("<!doctype html><meta name=viewport content='width=device-width'><style>%s</style><body>"
                         "<div class='%s'>%s</div>" % (css, grid_class, CARD))
        out = page.evaluate("""() => {
          const r = e => { const b = e.getBoundingClientRect(); return [b.right, b.top, b.bottom]; };
          return {marks: [...document.querySelectorAll('.card-marks > *')].map(r), more: r(document.querySelector('.card-more'))};
        }""")
        b.close()
    return out


@pytest.mark.local_gate
def test_marks_stack_in_a_column_above_the_dots_on_a_wide_row():
    pytest.importorskip("playwright")
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    o = _boxes(390, "stats-grid pick-grid")
    lefts = {round(m[0]) for m in o["marks"]}  # their right edges: the marks are glyphs of different widths, so only the edge they stack on is one line
    tops = [m[1] for m in o["marks"]]
    assert len(lefts) == 1, o  # one column
    assert tops == sorted(tops) and len(set(tops)) == 3, o  # one under the other
    assert o["more"][1] > o["marks"][-1][1], o  # the dots (a 44px touch box) sit below the last mark
