"""Articles follow Zimi, and Zimi is the one that may follow the system.

The chain is OS -> Zimi -> articles, and the middle link was missing. An
article carrying its own dark mode decided by reading prefers-color-scheme,
which is the SYSTEM's answer, so a dark Zimi on a light Mac served a light
article inside a dark app. Nothing in the settings explained that, because
nothing in the settings was doing it.

Eric, 2026-09-13: "Zimi can optionally follow OS, but articles follow Zimi."

Pushing a scheme at a document has to work through both mechanisms a page can
carry, and they are not the same mechanism:

  * `color-scheme` on the root, which is what decides how prefers-color-scheme
    resolves inside that document. Covers every page whose dark mode is a
    media query.
  * MediaWiki's theme class. Vector 2022 does NOT use a media query — it
    stamps `skin-theme-clientpref-os` on <html> and its own CSS reads the
    class — so the class has to be swapped by hand. That covers every
    Wikipedia-family ZIM, which is most of a typical library.

Both are exercised here against real documents in a real browser, because the
whole claim is about what the page PAINTS, and neither mechanism can be
checked by reading markup.

Run: pytest tests/test_article_theme.py -v
"""

import functools
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

APP_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi", "static", "app.js",
)

# A page whose dark mode is a media query — the ordinary case on the open web,
# and what a captured site usually carries.
MEDIA_QUERY_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>
  body { background: #ffffff; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #101014; color: #eee; } }
</style></head><body><p>hello</p></body></html>"""

# And MediaWiki's, which ignores the query entirely. `-os` is what a ZIM ships:
# follow the system. That is precisely the setting Zimi has to override.
MEDIAWIKI_PAGE = """<!doctype html>
<html class="vector-feature-night-mode-enabled skin-theme-clientpref-os"><head>
<meta charset="utf-8"><style>
  html.skin-theme-clientpref-day body { background: #ffffff; color: #202122; }
  html.skin-theme-clientpref-night body { background: #101418; color: #eaecf0; }
  @media (prefers-color-scheme: dark) {
    html.skin-theme-clientpref-os body { background: #101418; color: #eaecf0; }
  }
  @media (prefers-color-scheme: light) {
    html.skin-theme-clientpref-os body { background: #ffffff; color: #202122; }
  }
</style></head><body><p>hello</p></body></html>"""


def _need_browser():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright is not installed here")


def browser(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        _need_browser()
        return fn(*a, **kw)

    return wrapper


_SRC = open(APP_JS, encoding="utf-8").read()


def _function(name):
    """Lift one function out of app.js. It is a browser bundle with no module
    system, so the alternative is loading 18k lines to call three."""
    i = _SRC.index("function " + name + "(")
    depth = 0
    for k in range(_SRC.index("{", i), len(_SRC)):
        if _SRC[k] == "{":
            depth += 1
        elif _SRC[k] == "}":
            depth -= 1
            if depth == 0:
                return _SRC[i:k + 1]
    raise AssertionError("unbalanced " + name)


def _statement(name):
    """Lift one `var NAME = ...;` line out of app.js, verbatim."""
    i = _SRC.index("var " + name + " =")
    return _SRC[i:_SRC.index("\n", i)]


# Everything _askArticleFor reaches for, in dependency order. Taken from the
# source rather than restated here, so a change to a selector or a class name
# cannot pass this file while breaking the app.
ASKER = "\n".join(
    [_statement(n) for n in (
        "_PCS_ALWAYS", "_PCS_NEVER", "_PCS_DARK_RE", "_PCS_LIGHT_RE",
        "_PCS_ANY_RE", "_pcsOriginal", "_PCS_SCAN_MAX", "_MW_THEME_RE",
    )]
    + [_SRC[_SRC.index("var _MW_THEME_CLASS ="):_SRC.index("\n", _SRC.index("var _MW_THEME_CLASS ="))]]
    + [_function(n) for n in ("_retunedQuery", "_retuneColorSchemeQueries", "_askArticleFor")]
)


def _luminance(page, frame_selector="iframe"):
    return page.evaluate(
        """(sel) => {
             const d = document.querySelector(sel).contentDocument;
             const p = getComputedStyle(d.body).backgroundColor.match(/[\\d.]+/g).map(Number);
             return +((0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]) / 255).toFixed(3);
           }""",
        frame_selector,
    )


def _harness(pw, os_scheme, doc):
    """A page holding the document in an iframe, with the asker available.

    The iframe matters: prefers-color-scheme inside a frame resolves against
    the frame's own used color scheme, which is the mechanism being tested. A
    top-level document would only ever read the OS.
    """
    browser_ = pw.chromium.launch()
    page = browser_.new_page(color_scheme=os_scheme)
    page.set_content('<iframe id="f" style="width:400px;height:200px"></iframe>')
    page.evaluate(
        """(html) => new Promise(res => {
             const f = document.getElementById('f');
             f.onload = () => res();
             f.srcdoc = html;
           })""",
        doc,
    )
    page.add_script_tag(content=ASKER)
    return browser_, page


def _ask(page, mode):
    page.evaluate(
        "(m) => _askArticleFor(document.getElementById('f').contentDocument, m)", mode
    )


@browser
@pytest.mark.parametrize("os_scheme", ["light", "dark"])
def test_a_media_query_page_paints_what_zimi_asks_for(os_scheme):
    """Whatever the system says. `light` is the interesting direction on a dark
    Mac and `dark` on a light one; both run, so neither passes by accident."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        b, page = _harness(pw, os_scheme, MEDIA_QUERY_PAGE)
        try:
            _ask(page, "dark")
            assert _luminance(page) < 0.2, "asked for dark, painted light"
            _ask(page, "light")
            assert _luminance(page) > 0.8, "asked for light, painted dark"
        finally:
            b.close()


@browser
@pytest.mark.parametrize("os_scheme", ["light", "dark"])
def test_a_mediawiki_page_paints_what_zimi_asks_for(os_scheme):
    """The case that covers most of a real library. MediaWiki reads its own
    class, not the media query, so color-scheme alone would do nothing here."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        b, page = _harness(pw, os_scheme, MEDIAWIKI_PAGE)
        try:
            _ask(page, "dark")
            assert _luminance(page) < 0.2, "the theme class was not swapped to night"
            _ask(page, "light")
            assert _luminance(page) > 0.8, "the theme class was not swapped to day"
        finally:
            b.close()


@browser
def test_handing_the_page_back_restores_what_the_zim_shipped():
    """`-os` is a real choice a ZIM makes, and Zimi borrows the class rather
    than owning it. Reader View turns on and the page must get its own
    behaviour back — not whichever face Zimi last picked."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        b, page = _harness(pw, "dark", MEDIAWIKI_PAGE)
        try:
            _ask(page, "light")
            _ask(page, "")
            klass = page.evaluate(
                "() => document.getElementById('f').contentDocument.documentElement.className"
            )
            assert "skin-theme-clientpref-os" in klass, klass
            # And it is following the system again: a dark OS, a dark page.
            assert _luminance(page) < 0.2
        finally:
            b.close()
