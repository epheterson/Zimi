"""The catalog icon endpoint.

Small, but it takes a name straight from a URL and uses it to read out of a
tar, so the traversal case is worth pinning here as well as in the reader.

Run: pytest tests/test_catalog_icon_endpoint.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi import catalog_snapshot  # noqa: E402


@pytest.fixture
def icons(tmp_path, monkeypatch):
    path = tmp_path / "icons.tar"
    catalog_snapshot.write_icons(str(path), {"a1b2c3d4e5f60718": b"RIFFWEBP"})
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(path))
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(tmp_path / "none.gz"))
    catalog_snapshot._reset_for_tests()
    yield
    catalog_snapshot._reset_for_tests()


class _Handler:
    """Enough of the request handler to see what the endpoint would send."""

    def __init__(self):
        self.code = None
        self.headers = {}
        self.body = b""
        self.json = None

        class _Wfile:
            def __init__(self, outer):
                self.outer = outer

            def write(self, data):
                self.outer.body += data

        self.wfile = _Wfile(self)

    def send_response(self, code):
        self.code = code

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def _json(self, code, data):
        self.code = code
        self.json = data


def _call(name):
    from zimi.http import ZimHandler

    handler = _Handler()
    ZimHandler._serve_catalog_icon(handler, name)
    return handler


def test_a_known_icon_is_served_as_webp(icons):
    handler = _call("a1b2c3d4e5f60718")
    assert handler.code == 200
    assert handler.body == b"RIFFWEBP"
    assert handler.headers["Content-Type"] == "image/webp"
    assert handler.headers["Content-Length"] == "8"


def test_it_is_cached_forever_because_the_name_is_the_content(icons):
    """Content-addressed, so the bytes behind a name can never change. That is
    what makes a year of immutable caching correct rather than reckless."""
    handler = _call("a1b2c3d4e5f60718")
    assert "immutable" in handler.headers["Cache-Control"]
    assert "max-age=31536000" in handler.headers["Cache-Control"]


def test_an_unknown_icon_is_a_404(icons):
    handler = _call("000000000000ffff")
    assert handler.code == 404
    assert handler.body == b""


@pytest.mark.parametrize(
    "name",
    ["../../../../etc/passwd", "..%2f..%2fetc", "", "a/b", "NOTHEX", "a" * 300],
)
def test_a_name_that_is_not_a_digest_is_refused(icons, name):
    handler = _call(name)
    assert handler.code == 404
    assert handler.body == b""


def test_it_answers_even_with_no_icons_shipped(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(tmp_path / "nope.tar"))
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(tmp_path / "nope.gz"))
    catalog_snapshot._reset_for_tests()
    try:
        assert _call("a1b2c3d4e5f60718").code == 404
    finally:
        catalog_snapshot._reset_for_tests()
