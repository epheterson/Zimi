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


def build_wiki_fixture_zim(path: str) -> str:
    """Write a tiny wikipedia-shaped ZIM at `path` for the almanac title fallback.

    Exercises both exact-title fallback shapes:
      - a DIRECT article ('A/Mercury_(planet)')
      - a REDIRECT ('A/Sun' → canonical 'A/Sol') so the resolver must follow one
        hop to the canonical entry path.

    Carries NO Q-ID index, so resolve_almanac_qids can only reach these via the
    curated-title fallback (which is the whole point).
    """
    from libzim.writer import Blob  # noqa: F401  (Creator API completeness)

    articles = [
        (
            "A/Mercury_(planet)",
            "Mercury (planet)",
            b"<html><body><h1>Mercury</h1><p>Closest planet to the Sun."
            b"</p></body></html>",
        ),
        (
            "A/Sol",
            "Sun",
            b"<html><body><h1>Sun</h1><p>The star at the centre." b"</p></body></html>",
        ),
    ]
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath("A/Mercury_(planet)")
        for p, t, h in articles:
            creator.add_item(_Article(p, t, h))
        # 'Sun' as a redirect to the canonical 'A/Sol' entry.
        creator.add_redirection("A/Sun", "Sun", "A/Sol", {})
        creator.add_metadata("Title", "Test Wikipedia")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Description", "tiny wiki fixture")
    assert os.path.exists(path)
    return path


class _MediaItem(Item):
    """A media entry (video/audio) with arbitrary bytes — including zero, to
    stand in for a broken/partial scrape's empty placeholder."""

    def __init__(self, path: str, mimetype: str, content: bytes):
        super().__init__()
        self._path = path
        self._mimetype = mimetype
        self._content = content

    def get_path(self) -> str:
        return self._path

    def get_title(self) -> str:
        return ""

    def get_mimetype(self) -> str:
        return self._mimetype

    def get_contentprovider(self) -> ContentProvider:
        return _StringProvider(self._content)

    def get_hints(self) -> dict:
        return {Hint.FRONT_ARTICLE: False}


def build_empty_text_fixture_zim(path: str) -> str:
    """Write a ZIM that opens fine and has entries, but every text/html article
    is 0-byte — the media-free shape of a broken scrape. The health check's
    text-sanity sampler must flag it even though the media sampler finds nothing.
    Returns the path."""
    articles = [
        ("A/Alpha", "Alpha", b""),
        ("A/Bravo", "Bravo", b""),
        ("A/Charlie", "Charlie", b""),
    ]
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath("A/Alpha")
        for p, t, h in articles:
            creator.add_item(_Article(p, t, h))
        creator.add_metadata("Title", "Empty Scrape")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Description", "empty-article fixture")
    assert os.path.exists(path)
    return path


def build_media_fixture_zim(path: str) -> str:
    """Write a ZIM with one article, one real video, and one ZERO-BYTE video.

    Mirrors the partial-scrape shape (e.g. ted_en_technology_2023-09: real
    .webm alongside 0-byte .mp4 placeholders) so the health check's media
    sampler has a genuine empty media entry to flag. Returns the path."""
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath("A/Talks")
        creator.add_item(
            _Article(
                "A/Talks",
                "Talks",
                b"<html><body><h1>Talks</h1></body></html>",
            )
        )
        creator.add_item(
            _MediaItem("videos/1/video.webm", "video/webm", b"\x1aE\xdf\xa3real")
        )
        creator.add_item(_MediaItem("videos/2/video.webm", "video/webm", b""))
        creator.add_metadata("Title", "Test Talks")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Description", "media fixture")
    assert os.path.exists(path)
    return path
