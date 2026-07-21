"""Build a tiny real .zim fixture with libzim.writer.

The rest of the suite mocks archives into stubs, so nothing exercises real
libzim content reads — and, more importantly, nothing exercises CONCURRENT
libzim access, which is the catastrophic (segfault) failure class since libzim
is not thread-safe. This helper builds a few-KB real ZIM once so a stress test
can hammer real reads from many threads.
"""

import os

from libzim.writer import Creator, Item, ContentProvider, Hint


class _StringProvider(ContentProvider):
    def __init__(self, content: bytes):
        super().__init__()
        self.content = content
        self._fed = False

    def get_size(self) -> int:
        return len(self.content)

    def feed(self):
        from libzim.writer import Blob

        if self._fed:
            return Blob(b"")
        self._fed = True
        return Blob(self.content)


class _Article(Item):
    def __init__(self, path: str, title: str, html: bytes):
        super().__init__()
        self._path = path
        self._title = title
        self._html = html

    def get_path(self) -> str:
        return self._path

    def get_title(self) -> str:
        return self._title

    def get_mimetype(self) -> str:
        return "text/html"

    def get_contentprovider(self) -> ContentProvider:
        return _StringProvider(self._html)

    def get_hints(self) -> dict:
        return {Hint.FRONT_ARTICLE: True}


def build_fixture_zim(path: str) -> str:
    """Write a 3-article ZIM at `path`; return the path."""
    articles = [
        (
            "A/Water",
            "Water purification",
            b"<html><body><h1>Water purification"
            b"</h1><p>Boil, filter, treat. <a href='A/Fire'>Fire</a></p></body></html>",
        ),
        (
            "A/Fire",
            "Fire",
            b"<html><body><h1>Fire</h1><p>Heat and light." b"</p></body></html>",
        ),
        (
            "A/Shelter",
            "Shelter",
            b"<html><body><h1>Shelter</h1><p>Stay dry and warm." b"</p></body></html>",
        ),
    ]
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath("A/Water")
        for p, t, h in articles:
            creator.add_item(_Article(p, t, h))
        creator.add_metadata("Title", "Test Survival")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Description", "tiny fixture")
    assert os.path.exists(path)
    return path
