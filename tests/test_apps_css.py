"""The apps share one stylesheet and one script, inlined by the server.

Run: pytest tests/test_apps_css.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from zimi import http  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")


def test_every_app_page_carries_the_mark_and_no_palette_of_its_own():
    for name in http.APP_PAGES:
        with open(os.path.join(STATIC, name), "rb") as f:
            body = f.read()
        assert body.count(http._APPS_CSS_MARK) == 1, name
        assert body.count(http._APPS_JS_MARK) == 1, name
        assert b"function esc(" not in body, name + " defines its own helpers"
        assert b"--amber:" not in body, name + " defines its own palette"
        assert b"prefers-color-scheme" not in body, name + " carries its own dark theme"


def test_the_sheet_and_the_script_are_inlined_once_each():
    with open(os.path.join(STATIC, "tube.html"), "rb") as f:
        raw = f.read()
    served = http._inline_apps_assets(raw)
    assert http._APPS_CSS_MARK not in served
    assert http._APPS_JS_MARK not in served
    assert served.count(b"--amber:") == 2, "the light and the dark value"
    assert b"prefers-color-scheme: dark" in served
    assert served.index(b"<style>") < served.index(b"<body")
    assert served.count(b"function esc(") == 1
    assert served.index(b"function esc(") < served.index(b"var STR = strings(")


def test_the_sheet_is_part_of_the_asset_bundle():
    with open(http.__file__, encoding="utf-8") as f:
        src = f.read()
    assert '_static_hash("apps.css")' in src
    assert '_static_hash("apps.js")' in src
