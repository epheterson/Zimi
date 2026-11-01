"""A capture's ZIM carries what only the capture could know.

The alive and zimit engines hand a WARC to warc2zim, which writes the ZIM and
accepts nine flags. Everything Zimi learned while capturing — which entries are
pages, what URL each came from, what the live page looked like — was dropped at
that door, and the damage was not confined to the capture: one two-page site put
eight hundred asset URLs into the library's shared vocabulary.

So the file is rewritten once at creation. These tests hold the two rules that
make that safe: only standard fields used as the spec intends plus ``X-``
metadata, and nothing else moves.

Run: pytest tests/test_zimpatch.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi.libzimcompat import entry_by_id
from zimi import zimpatch  # noqa: E402

libzim_reader = pytest.importorskip("libzim.reader")
libzim_writer = pytest.importorskip("libzim.writer")

PAGE_URL = "https://example.com/guide"
ASSET_PATH = "example.com/img/logo.png"


class _Item(libzim_writer.Item):
    def __init__(self, path, title, mimetype, data, front=False):
        super().__init__()
        self._p, self._t, self._m, self._d, self._f = path, title, mimetype, data, front

    def get_path(self):
        return self._p

    def get_title(self):
        return self._t

    def get_mimetype(self):
        return self._m

    def get_contentprovider(self):
        return libzim_writer.StringProvider(self._d)

    def get_hints(self):
        return {libzim_writer.Hint.FRONT_ARTICLE: self._f}


@pytest.fixture
def captured_zim(tmp_path):
    """A ZIM shaped like one warc2zim writes: pages and assets side by side,
    every HTML entry marked a front article, a redirect, and its own metadata.
    """
    path = str(tmp_path / "capture.zim")
    with libzim_writer.Creator(path).config_indexing(True, "eng") as c:
        c.add_item(
            _Item(
                "example.com/guide",
                "Served title",
                "text/html",
                b"<html><body><p>the guide</p></body></html>",
                front=True,
            )
        )
        # warc2zim marks any HTML a front article, including a third-party
        # widget the capture never treated as a page.
        c.add_item(
            _Item(
                "widget.vendor.example/feedback.html",
                "Feedback",
                "text/html",
                b"<html><body>widget</body></html>",
                front=True,
            )
        )
        c.add_item(_Item(ASSET_PATH, "logo.png", "image/png", b"\x89PNG-bytes"))
        c.add_item(
            _Item("_zim_static/wombat.js", "wombat.js", "application/javascript", b"//")
        )
        c.add_redirection(
            "example.com/old",
            "Old",
            "example.com/guide",
            {libzim_writer.Hint.FRONT_ARTICLE: False},
        )
        for key, value in (
            ("Title", b"Example"),
            ("Language", b"eng"),
            ("Creator", b"Zimi"),
            ("Publisher", b"openZIM"),
            ("Description", b"example.com"),
            ("Date", b"2026-09-07"),
        ):
            c.add_metadata(key, value)
        c.set_mainpath("example.com/guide")
    return path


@pytest.fixture
def record():
    return zimpatch.build_record(
        seed_url=PAGE_URL,
        engine="alive",
        pages=[{"url": PAGE_URL, "title": "The guide, as captured"}],
        assets=2,
    )


def test_a_url_becomes_the_path_warc2zim_stores_it_at():
    # This mapping is the whole reason the record can name pages at all.
    assert zimpatch.zim_path_for_url("https://x.com/a?b=1") == "x.com/a?b=1"
    assert zimpatch.zim_path_for_url("http://x.com/a") == "x.com/a"
    assert zimpatch.zim_path_for_url("ftp://x.com/a") == ""
    assert zimpatch.zim_path_for_url("") == ""


def test_only_the_pages_the_capture_visited_are_articles(captured_zim, record):
    before = libzim_reader.Archive(captured_zim)
    assert before.article_count == 2  # the page AND the third-party widget
    del before

    assert zimpatch.patch(captured_zim, record) is True

    after = libzim_reader.Archive(captured_zim)
    # The field every viewer reads for "is this a page" now says what the
    # capture knows: one page. Kiwix's random and suggestions improve from
    # exactly this, which is why it is the standard field and not our own.
    assert after.article_count == 1


def test_the_page_keeps_the_title_a_person_saw(captured_zim, record):
    zimpatch.patch(captured_zim, record)
    after = libzim_reader.Archive(captured_zim)
    assert (
        after.get_entry_by_path("example.com/guide").title == "The guide, as captured"
    )


def test_the_record_travels_in_the_file(captured_zim, record):
    zimpatch.patch(captured_zim, record)
    after = libzim_reader.Archive(captured_zim)
    stored = zimpatch.read_record(after)
    assert stored["engine"] == "alive"
    assert stored["assets"] == 2
    assert stored["pages"] == [
        {
            "path": "example.com/guide",
            "url": PAGE_URL,
            "title": "The guide, as captured",
        }
    ]
    assert json.loads(bytes(after.get_metadata(zimpatch.CAPTURE_METADATA_KEY)))


def test_the_source_url_warc2zim_drops_is_written(captured_zim, record):
    before = libzim_reader.Archive(captured_zim)
    assert "Source" not in before.metadata_keys
    del before
    zimpatch.patch(captured_zim, record)
    after = libzim_reader.Archive(captured_zim)
    assert bytes(after.get_metadata("Source")).decode() == PAGE_URL
    assert bytes(after.get_metadata("Publisher")).decode() == "Zimi"


def test_both_pictures_are_metadata_in_the_zim(captured_zim, record):
    zimpatch.patch(
        captured_zim, record, live_shot=b"\xff\xd8live", packaged_shot=b"\xff\xd8zim"
    )
    after = libzim_reader.Archive(captured_zim)
    assert bytes(after.get_metadata("X-Zimi-Screenshot")) == b"\xff\xd8live"
    assert bytes(after.get_metadata("X-Zimi-Screenshot-Zim")) == b"\xff\xd8zim"


def test_nothing_else_moves(captured_zim, record):
    before = libzim_reader.Archive(captured_zim)
    paths = {
        entry_by_id(before, i).path for i in range(before.all_entry_count)
    } - set(before.metadata_keys)
    main = before.main_entry.get_item().path
    del before

    zimpatch.patch(captured_zim, record)

    after = libzim_reader.Archive(captured_zim)
    after_paths = {
        entry_by_id(after, i).path for i in range(after.all_entry_count)
    } - set(after.metadata_keys)
    assert paths <= after_paths, "an entry went missing"
    assert after.main_entry.get_item().path == main
    # The replay machinery and the assets are untouched, byte for byte.
    assert (
        bytes(after.get_entry_by_path(ASSET_PATH).get_item().content)
        == b"\x89PNG-bytes"
    )
    assert after.has_entry_by_path("_zim_static/wombat.js")
    # A redirect is still a redirect, pointing where it pointed.
    old = after.get_entry_by_path("example.com/old")
    assert old.is_redirect
    assert old.get_redirect_entry().path == "example.com/guide"
    assert after.has_fulltext_index


def test_a_file_that_cannot_be_rewritten_is_left_exactly_as_it_was(tmp_path, record):
    # A capture that succeeded must never be lost to an enrichment step.
    path = str(tmp_path / "not-a-zim.bin")
    with open(path, "wb") as f:
        f.write(b"this is not a ZIM at all")
    said = []
    assert zimpatch.patch(path, record, note=said.append) is False
    with open(path, "rb") as f:
        assert f.read() == b"this is not a ZIM at all"
    assert any("as the converter wrote it" in line for line in said)
    # And no half-written file was left beside it.
    assert [p for p in os.listdir(tmp_path) if p.startswith(".zimi-patch-")] == []


def test_a_page_the_record_names_but_the_zim_lacks_is_ignored(captured_zim):
    record = zimpatch.build_record(
        seed_url=PAGE_URL,
        engine="alive",
        pages=[{"url": "https://example.com/never-captured", "title": "Ghost"}],
        assets=0,
    )
    assert zimpatch.patch(captured_zim, record) is True
    after = libzim_reader.Archive(captured_zim)
    assert after.article_count == 0  # nothing claimed to be a page
    assert after.has_entry_by_path("example.com/guide")


def test_the_alive_engine_calls_the_patcher():
    import inspect

    from zimi import alive

    source = inspect.getsource(alive)
    assert "zimpatch.patch(" in source
    assert source.count("finish_zim(") >= 3  # the definition and both engines


def test_the_picture_is_taken_of_the_page_that_ships(captured_zim, record):
    """The shot callback sees the rewritten document, not the source one.

    warc2zim's HTML does not run. A module loader that identifies its chunks by
    the src attribute the server sent finds nothing once that reference has been
    made relative, which is what the loader shim undoes. Photographing the
    converter's output therefore produced a picture of a page that never ships —
    a shell with an empty middle — and then a "much shorter than the live one"
    warning about a ZIM that renders perfectly once opened. So the picture is
    taken during the rewrite, from the bytes going into the file.
    """
    seen = {}

    def shoot(html, by_path, mainpath):
        seen["html"] = html
        seen["mainpath"] = mainpath
        seen["asset"] = by_path.get(ASSET_PATH)
        return b"\xff\xd8shot-of-the-real-thing"

    assert zimpatch.patch(captured_zim, record, live_shot=b"\xff\xd8live", shoot=shoot)

    after = libzim_reader.Archive(captured_zim)
    stored = bytes(after.get_entry_by_path("example.com/guide").get_item().content)
    assert seen["html"].encode("utf-8") == stored
    assert seen["mainpath"] == "example.com/guide"
    # Assets are carried across byte for byte, so the source archive answers
    # for them and the browser can resolve the page's references.
    assert seen["asset"] == ("image/png", b"\x89PNG-bytes")
    assert bytes(after.get_metadata("X-Zimi-Screenshot-Zim")) == (
        b"\xff\xd8shot-of-the-real-thing"
    )


def test_a_shot_that_fails_costs_the_picture_and_nothing_else(captured_zim, record):
    def shoot(html, by_path, mainpath):
        raise RuntimeError("no browser here")

    assert zimpatch.patch(captured_zim, record, live_shot=b"\xff\xd8live", shoot=shoot)
    after = libzim_reader.Archive(captured_zim)
    assert bytes(after.get_metadata("X-Zimi-Screenshot")) == b"\xff\xd8live"
    assert "X-Zimi-Screenshot-Zim" not in set(after.metadata_keys)
    assert after.has_main_entry


def test_the_two_pictures_sizes_are_recorded(captured_zim, record):
    """The About panel compares the pair for every other engine; a ZIM warc2zim
    wrote is not the exception."""
    from zimi.zimwriter import SHOT_DIMS_METADATA_KEY

    live = _jpeg(1280, 4000)
    packaged = _jpeg(1280, 3990)
    zimpatch.patch(captured_zim, record, live_shot=live, packaged_shot=packaged)
    after = libzim_reader.Archive(captured_zim)
    assert (
        bytes(after.get_metadata(SHOT_DIMS_METADATA_KEY)).decode()
        == "1280x4000,1280x3990"
    )


def _jpeg(width, height):
    """The smallest thing jpeg_size will read a size out of: SOI then an SOF0
    frame header carrying the dimensions, with a byte of scan data after it so
    the reader's bounds check can reach the header at all."""
    body = bytes([0x08]) + height.to_bytes(2, "big") + width.to_bytes(2, "big")
    segment = (len(body) + 2).to_bytes(2, "big") + body
    return b"\xff\xd8" + b"\xff\xc0" + segment + b"\x00"
