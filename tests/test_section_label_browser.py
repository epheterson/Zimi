"""One section label: the heading of a list on Home and in every app is drawn the same (13px, strong, caps, the quiet ink),
whatever file styles the page around it.

Run: pytest tests/test_section_label_browser.py -v
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.renderer as renderer  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")
LABELS = (
    '<div class="cat-heading">Maps</div>',
    '<div class="discover-label"><span>Discover</span></div>',
    '<div class="shelf-h"><h2>Subjects</h2></div>',
    '<div class="section-h">Answers</div>',
    '<div class="sec-h"><h2 class="serif">Picture of the day</h2></div>',
    '<div class="lang-h"><h2>English</h2></div>',
    '<h2 class="fg-h2">More</h2>',
)
STYLE = (
    "e => { const c = getComputedStyle(e); "
    "return [c.fontFamily === getComputedStyle(document.body).fontFamily, c.fontSize, c.fontWeight, c.textTransform, c.letterSpacing]; }"
)


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def page():
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b.new_page(viewport={"width": 390, "height": 844})
        b.close()


@pytest.mark.parametrize("sheet", ["app.css", "apps.css"])
def test_every_section_label_is_drawn_the_same(page, sheet):
    # A page's own styles are in its html; the shared sheet and the tokens are what must agree, and its serif class is
    # the wiki's own (.serif sets a family).
    css = _read("tokens.css") + _read(sheet) + ".serif { font-family: Georgia, serif; }"
    page.set_content("<style>%s</style><body>%s" % (css, "".join(LABELS)))
    seen = set()
    for sel in (".cat-heading", ".discover-label", ".shelf-h h2", ".section-h", ".sec-h h2", ".lang-h h2", ".fg-h2"):
        style = page.eval_on_selector(sel, STYLE)
        # discover-label is the span's parent: its own text is the label.
        seen.add(tuple(style))
    assert len(seen) == 1, seen
    assert next(iter(seen))[1:4] == ("13px", "600", "uppercase")


def test_no_page_restyles_a_section_label():
    for name in ("wiki.html", "dictionary.html", "fieldguide.html", "books.html", "exchange.html", "reddot.html"):
        src = _read(name)
        for m in re.finditer(r"\.(?:sec-h h2|lang-h h2|shelf-h h2|fg-h2|section-h)\s*\{([^}]*)\}", src):
            assert not re.search(r"font-size|font-weight|text-transform|letter-spacing|color", m.group(1)), (name, m.group(0))


def _decl(css, selector, prop):
    m = re.search(r"(?:^|\n)%s \{([^}]*)\}" % re.escape(selector), css)
    assert m, selector
    v = re.search(r"(?:^|[;\s])%s:\s*([^;]+);" % prop, m.group(1))
    return v.group(1).strip() if v else None


def test_the_almanac_and_the_games_use_the_same_label():
    """Their standalone ZIMs carry no tokens, so each writes the label's values out; they must stay Zimi's."""
    games = _read(os.path.join("..", "builtin", "games", "games.css"))
    alm = _read("almanac.css")
    want = {"font-size": "13px", "font-weight": "600", "letter-spacing": "0.06em", "text-transform": "uppercase"}
    for css, selector in ((games, ".ar-section h2"), (alm, ".almanac-section-title"), (alm, ".alm-tiles-h")):
        got = {p: _decl(css, selector, p) for p in want}
        got["font-size"] = {"var(--fs-small)": "13px"}.get(got["font-size"], got["font-size"])
        assert got == want, (selector, got)
    tokens = _read("tokens.css")
    assert "font-size: var(--fs-small)" in tokens and "letter-spacing: 0.06em" in tokens and "text-transform: uppercase" in tokens


def test_the_games_all_chip_is_amber_when_chosen_like_the_others():
    games = _read(os.path.join("..", "builtin", "games", "games.css"))
    assert "sh-chip-all[aria-pressed" not in games
