"""The dice on a capture land on its page, not on "no articles found".

Found on the NAS library: /random?zim=www_cnn_com answered "no articles
found" 7 of 7 times, and Random on the page left the site. The capture has
446 entries and one page; eight random entry indices almost never land on it.
libzim's own pick among front articles does.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import search  # noqa: E402


class _Item:
    def __init__(self, mt):
        self.mimetype = mt


class _Entry:
    def __init__(self, path, mt, title=""):
        self.path, self.title, self.is_redirect, self._mt = path, title, False, mt

    def get_item(self):
        return _Item(self._mt)


class _Capture:
    entry_count = 446
    article_count = 1

    def _get_entry_by_id(self, i):
        return _Entry(f"assets/{i}.css", "text/css")

    def get_random_entry(self):
        return _Entry("A/index", "text/html", "CNN front page")

    def get_entry_by_path(self, p):
        raise KeyError(p)


def test_a_one_page_capture_rolls_its_page(monkeypatch):
    monkeypatch.setattr(search, "_capture_page_paths", lambda a: set())
    monkeypatch.setattr(search, "SuggestionSearcher", lambda a: (_ for _ in ()).throw(RuntimeError("no")))
    got = search.random_entry(_Capture())
    assert got == {"path": "A/index", "title": "CNN front page"}
