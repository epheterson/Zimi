"""Regression guard for the zimit/wombat <a href> doubling bug (#17).

Background: ZIMs scraped by `zimit` ship with wombat.js, which rewrites
the `<a href>` ATTRIBUTE to look like the original archived URL
(e.g. `https://ersatztv.org/docs/`) and installs its own click handler
that re-resolves it against the iframe URL — doubling the path on
every nested navigation. Kiwix's viewer.js fixes this with a
`_no_rewrite=true` trick that asks wombat to return the actual
in-archive URL it computed at page-load time.

This test asserts our iframe click handler in app.js follows the same
pattern, so a future refactor can't silently regress the fix.
"""

import os
import re

APP_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "app.js",
)


def _read_app_js() -> str:
    with open(APP_JS, encoding="utf-8") as f:
        return f.read()


def test_iframe_click_handler_uses_no_rewrite_trick():
    """The handler must read href via wombat's _no_rewrite=true pattern,
    not via a raw getAttribute('href') alone."""
    src = _read_app_js()
    # Both the assignment AND the use must be present in the same handler.
    assert "_no_rewrite = true" in src, (
        "iframe click handler must set a._no_rewrite = true before reading "
        "a.href to bypass wombat's URL rewriting (issue #17)"
    )


def test_iframe_click_handler_restores_no_rewrite_flag():
    """After reading the real href the handler must restore the previous
    flag value so wombat's other consumers behave normally."""
    src = _read_app_js()
    # Snapshot pattern: capture prev → set true → read → restore prev.
    assert re.search(
        r"_prevNoRewrite\s*=\s*\w+\._no_rewrite",
        src,
    ), "must snapshot the previous _no_rewrite value before flipping it"
    assert re.search(
        r"\._no_rewrite\s*=\s*_prevNoRewrite",
        src,
    ), "must restore the previous _no_rewrite value after reading href"


def test_iframe_click_handler_uses_capture_phase():
    """Wombat installs its own click handler that re-resolves URLs.
    Ours must run BEFORE wombat's, so the listener must register with
    capture: true (third arg) on the iframe document."""
    src = _read_app_js()
    # Find the click registration on frame.contentDocument
    pattern = re.compile(
        r"frame\.contentDocument\.addEventListener\(\s*['\"]click['\"]\s*,\s*\w+\s*,\s*true\s*\)",
    )
    assert pattern.search(src), (
        "iframe click handler must register with capture: true so it runs "
        "before wombat's own click interceptor (issue #17)"
    )


def test_app_js_documents_issue_17_intent():
    """Future maintainers should see the WHY when they read the code,
    not just the cryptic _no_rewrite flag flip."""
    src = _read_app_js()
    assert "issue #17" in src.lower() or "wombat" in src.lower(), (
        "click handler should mention wombat or issue #17 inline so the "
        "trick isn't mysterious to future readers"
    )
