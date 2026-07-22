"""Save to ZIM v1 — export bookmarks to a real .zim and read it back.

Uses libzim.writer (present on the dev Mac and in Docker); guarded with
importorskip so the suite still collects where the writer is absent.
"""

import os
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.reader import Archive  # noqa: E402

import zimi.zimwriter as zw  # noqa: E402


def _fake_reader(zim, path):
    return (
        f"<html><head><title>{path}</title><script>bad()</script></head>"
        f"<body><h1>{path}</h1><p>Body of {zim}/{path}.</p>"
        "<a href='A/Other'>link</a></body></html>"
    )


def _bookmarks():
    return [
        {"zim": "survival", "path": "A/Water", "title": "Water purification"},
        {"zim": "survival", "path": "A/Fire", "title": "Fire"},
    ]


def test_empty_bookmarks_raises(tmp_path):
    with pytest.raises(ValueError):
        zw.build_bookmarks_zim([], str(tmp_path))


def test_export_creates_readable_zim(tmp_path):
    out = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    assert os.path.exists(out)
    assert os.path.basename(out).startswith("zimi-bookmarks_")

    arc = Archive(out)
    # index (main) + 2 articles all present and reachable
    assert arc.main_entry.get_item().path == "index"
    idx = bytes(arc.get_entry_by_path("index").get_item().content).decode("utf-8")
    assert "Water purification" in idx
    assert "Fire" in idx

    art = bytes(
        arc.get_entry_by_path("A/0_Water_purification").get_item().content
    ).decode("utf-8")
    assert "Body of survival/A/Water" in art
    assert "From <strong>survival</strong>" in art
    # scripts stripped from embedded body
    assert "bad()" not in art


def test_unreadable_source_becomes_placeholder(tmp_path):
    out = zw.build_bookmarks_zim(
        [{"zim": "gone", "path": "A/X", "title": "Missing"}],
        str(tmp_path),
        reader=lambda z, p: None,
    )
    arc = Archive(out)
    art = bytes(arc.get_entry_by_path("A/0_Missing").get_item().content).decode("utf-8")
    assert "could not be read" in art


def test_output_path_does_not_clobber(tmp_path):
    a = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    b = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    assert a != b
    assert os.path.exists(a) and os.path.exists(b)
