"""capability.js has one address: the Moon's loader and the Almanac's list ask for the same URL, so it downloads once."""

import os
import re

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi")


def _read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def test_capability_js_is_asked_for_by_one_address():
    index, app = _read("templates", "index.html"), _read("static", "app.js")
    addresses = set(re.findall(r"/static/capability\.js\?v=\d+", index + app))
    assert len(addresses) == 1, addresses
    assert "_CAPABILITY_JS" in index and "_loadScript(_CAPABILITY_JS)" in app
