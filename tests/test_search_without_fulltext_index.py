"""A ZIM with no full-text index still answers the search bar.

Kiwix's map ZIMs ship _ftindex:no, and so do some small captures. Their titles
are indexed (suggest found "Aana Alofi I" on the Samoa map all along), but the
full search path asked Xapian only, so the same words in the search bar
returned nothing. Titles are the fallback when there is nothing else to ask.

Run: pytest tests/test_search_without_fulltext_index.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402
import zimi.search as search  # noqa: E402


@pytest.fixture
def title_only_library(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "places_en_2026-09.zim"), indexing=False)
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    server.load_cache(force=True)
    return zdir


def test_the_fixture_really_has_no_fulltext_index(title_only_library):
    archive, _ = search._get_fts_archive("places")
    assert archive.has_fulltext_index is False
    assert archive.has_title_index is True


def test_full_search_falls_back_to_titles(title_only_library):
    """The slow path (fast=False) is what the search bar uses."""
    res = search.search_all("water", limit=5, fast=False)
    hits = [(r["zim"], r["path"]) for r in res["results"]]
    assert ("places", "A/Water") in hits, hits


def test_a_title_that_is_not_there_is_still_not_there(title_only_library):
    res = search.search_all("volcano", limit=5, fast=False)
    assert res["results"] == []
