"""The page runs under the notch and the home indicator (viewport-fit=cover), so
the header, the reader and Read aloud's bar must each keep out of those areas.
env(safe-area-inset-*) reads 0 without viewport-fit=cover, so the bar sat on the
curved corners of a phone and its insets never applied."""

import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "zimi")


def _read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def test_viewport_covers_the_screen():
    assert "viewport-fit=cover" in _read("templates", "index.html")


def test_header_and_reader_offset_by_the_safe_area():
    css = _read("static", "app.css")
    assert "--sat: env(safe-area-inset-top" in css
    assert re.search(r"\.topbar \{[^}]*height: calc\(56px \+ var\(--sat\)\)", css)
    assert "--under-topbar: calc(56px + var(--sat) + var(--conn-h))" in css
    assert re.search(r"\.reader-view \{[^}]*left: env\(safe-area-inset-left", css)
    assert re.search(r"\.tts-bar \{[^}]*env\(safe-area-inset-bottom", css)
