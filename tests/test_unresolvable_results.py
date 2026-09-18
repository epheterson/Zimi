"""A search result nobody can open is not a result.

A ZIM's full-text index can promise entries the archive does not contain. That
sounds theoretical; it is not. StreetZim's offline OpenStreetMap ZIMs carry an
index over their place shards, and every path in it fails to resolve. One map
in a library filled searches with rows titled "s/4394" that opened to nothing.

The old code kept those, titling each with its own path, because a result was
assumed to be better than no result. At one row it is not: a person clicks it,
gets nothing, and learns the search is broken.

Run: pytest tests/test_unresolvable_results.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi.search import search_zim  # noqa: E402


class _Item:
    def __init__(self, content=b"<p>hello</p>", size=None):
        self.content = content
        self.size = size if size is not None else len(content)
        self.mimetype = "text/html"


class _Entry:
    def __init__(self, title, item=None):
        self.title = title
        self._item = item or _Item()

    def get_item(self):
        return self._item


class _Archive:
    """An archive whose index promises more than it holds."""

    def __init__(self, present):
        self.present = present
        self.asked = []

    def get_entry_by_path(self, path):
        self.asked.append(path)
        if path not in self.present:
            raise KeyError("Cannot find entry")
        return _Entry(self.present[path])


def _patch_searcher(monkeypatch, paths):
    import zimi.search as search_mod

    class _Results:
        def getEstimatedMatches(self):
            return len(paths)

        def getResults(self, start, count):
            return paths[start : start + count]

    class _Searcher:
        def __init__(self, archive):
            pass

        def search(self, query):
            return _Results()

    class _Query:
        def set_query(self, q):
            return self

    monkeypatch.setattr(search_mod, "Searcher", _Searcher)
    monkeypatch.setattr(search_mod, "Query", _Query)


def test_an_unresolvable_path_is_dropped(monkeypatch):
    _patch_searcher(monkeypatch, ["s/4394", "A/Real", "s/4395"])
    archive = _Archive({"A/Real": "A Real Article"})
    results = search_zim(archive, "waikiki", limit=10)
    assert [r["path"] for r in results] == ["A/Real"]
    assert [r["title"] for r in results] == ["A Real Article"]


def test_a_result_is_never_titled_with_its_own_path(monkeypatch):
    """The visible symptom. Rows read "s/4394", which tells a person nothing
    and opens to nothing."""
    _patch_searcher(monkeypatch, ["s/4394", "s/4395", "s/9966"])
    results = search_zim(_Archive({}), "waikiki", limit=10)
    assert results == []


def test_every_path_is_still_tried(monkeypatch):
    """Dropping happens per result, not by abandoning the loop: one bad entry
    in the middle must not cost the good ones after it."""
    _patch_searcher(monkeypatch, ["bad/1", "A/One", "bad/2", "A/Two"])
    archive = _Archive({"A/One": "One", "A/Two": "Two"})
    results = search_zim(archive, "q", limit=10)
    assert [r["path"] for r in results] == ["A/One", "A/Two"]
    assert archive.asked == ["bad/1", "A/One", "bad/2", "A/Two"]


def test_a_healthy_archive_is_unaffected(monkeypatch):
    _patch_searcher(monkeypatch, ["A/One", "A/Two"])
    results = search_zim(_Archive({"A/One": "One", "A/Two": "Two"}), "q", limit=10)
    assert len(results) == 2
    assert all(r["title"] and r["title"] != r["path"] for r in results)
