#!/usr/bin/env python3
"""/w/ must never materialize an unbounded entry in RAM under _zim_lock.

The size ceiling used to guard only the non-streamable branch: a video or
audio entry fetched WITHOUT a Range header — curl, `<a download>`, a chat
app's link fetcher — copied the whole item into a bytes object while holding
the one lock every libzim read needs. Kiwix ships ZIMs with a few hundred MB
of embedded media, which is an OOM kill on a 1 GB board with every other
request blocked behind it. `bytes=0-` was the same hole through the ranged
door, and the EPUB branch read the item before checking its size at all.

These tests pin the replacement: every served window is clamped to
MAX_SERVE_BYTES, an over-cap media request is answered as 206 + Accept-Ranges
(players range-request onward), and the branches that can't be windowed check
the size BEFORE touching content.
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402

CAP = 1024  # MAX_SERVE_BYTES for the duration of these tests


class _FakeItem:
    """Minimal libzim Item. `size` is independent of `data` so an entry can
    claim to be huge without the test allocating it."""

    def __init__(self, data, mimetype, size=None, explode=False):
        self._data = data
        self.mimetype = mimetype
        self.size = len(data) if size is None else size
        self._explode = explode

    @property
    def content(self):
        if self._explode:
            raise AssertionError("entry content materialized before the size check")
        return memoryview(self._data)


class _FakeEntry:
    def __init__(self, item, title="Fake"):
        self._item = item
        self.title = title
        self.is_redirect = False

    def get_item(self):
        return self._item


class _FakeArchive:
    def __init__(self, entries):
        self._entries = entries

    def get_entry_by_path(self, path):
        if path in self._entries:
            return self._entries[path]
        raise KeyError(path)

    def get_metadata(self, name):
        raise RuntimeError("no metadata in the fake archive")


ZIM = "media"
BIG = b"\xde\xad\xbe\xef" * 1024  # 4 KB — four caps' worth
SMALL = b"tiny video payload"

_ENTRIES = {
    "v/big.mp4": _FakeEntry(_FakeItem(BIG, "video/mp4")),
    "v/small.mp4": _FakeEntry(_FakeItem(SMALL, "video/mp4")),
    "a/big.ogg": _FakeEntry(_FakeItem(BIG, "application/ogg")),
    "A/Page": _FakeEntry(_FakeItem(b"<html><body>hi</body></html>", "text/html")),
    # Claims 200 MB but explodes if anything reads it — proves the size check
    # runs before materialization on the branches that can't window.
    "d/huge.pdf": _FakeEntry(
        _FakeItem(b"", "application/pdf", size=200 * 1024 * 1024, explode=True)
    ),
    "b/huge.epub": _FakeEntry(
        _FakeItem(b"", "application/epub+zip", size=200 * 1024 * 1024, explode=True)
    ),
    "d/small.pdf": _FakeEntry(_FakeItem(b"%PDF-1.4 tiny", "application/pdf")),
}


def _start_server(zim_dir):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    os.environ["ZIM_DIR"] = zim_dir
    server.ZIM_DIR = zim_dir
    server.ZIMI_DATA_DIR = os.path.join(zim_dir, ".zimi")
    os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
    server.load_cache()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


class TestMediaServeCap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="zimi-cap-")
        cls._server, port = _start_server(cls._tmpdir)
        cls._base = f"http://127.0.0.1:{port}"
        archive = _FakeArchive(_ENTRIES)
        cls._saved = {
            name: getattr(server, name)
            for name in (
                "get_zim_files",
                "get_archive",
                "open_archive",
                "MAX_SERVE_BYTES",
            )
        }
        server.get_zim_files = lambda: {ZIM: "/fake/media.zim"}
        server.get_archive = lambda n=None: archive
        server.open_archive = lambda p=None: archive
        server.MAX_SERVE_BYTES = CAP

    @classmethod
    def tearDownClass(cls):
        for name, orig in cls._saved.items():
            setattr(server, name, orig)
        cls._server.shutdown()
        import shutil

        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _get(self, path, headers=None):
        req = urllib.request.Request(f"{self._base}{path}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    # ── streamable media ───────────────────────────────────────────────────

    def test_no_range_over_cap_is_capped_206(self):
        status, headers, body = self._get(f"/w/{ZIM}/v/big.mp4")
        self.assertEqual(status, 206)
        self.assertEqual(len(body), CAP)
        self.assertEqual(body, BIG[:CAP])
        self.assertEqual(headers.get("Content-Range"), f"bytes 0-{CAP - 1}/{len(BIG)}")
        self.assertEqual(headers.get("Accept-Ranges"), "bytes")
        self.assertEqual(headers.get("Content-Length"), str(CAP))

    def test_open_ended_range_is_clamped(self):
        # bytes=0- asks for the whole item through the ranged door.
        status, headers, body = self._get(f"/w/{ZIM}/v/big.mp4", {"Range": "bytes=0-"})
        self.assertEqual(status, 206)
        self.assertEqual(len(body), CAP)
        self.assertEqual(headers.get("Content-Range"), f"bytes 0-{CAP - 1}/{len(BIG)}")

    def test_oversized_explicit_range_is_clamped(self):
        status, headers, body = self._get(
            f"/w/{ZIM}/v/big.mp4", {"Range": "bytes=2000-"}
        )
        self.assertEqual(status, 206)
        self.assertEqual(len(body), CAP)
        self.assertEqual(body, BIG[2000 : 2000 + CAP])
        self.assertEqual(
            headers.get("Content-Range"), f"bytes 2000-{2000 + CAP - 1}/{len(BIG)}"
        )

    def test_in_bounds_range_is_served_verbatim(self):
        status, headers, body = self._get(
            f"/w/{ZIM}/v/big.mp4", {"Range": "bytes=100-199"}
        )
        self.assertEqual(status, 206)
        self.assertEqual(body, BIG[100:200])
        self.assertEqual(headers.get("Content-Range"), f"bytes 100-199/{len(BIG)}")

    def test_suffix_range_still_works(self):
        status, headers, body = self._get(f"/w/{ZIM}/v/big.mp4", {"Range": "bytes=-50"})
        self.assertEqual(status, 206)
        self.assertEqual(body, BIG[-50:])

    def test_malformed_range_over_cap_still_capped(self):
        status, headers, body = self._get(
            f"/w/{ZIM}/v/big.mp4", {"Range": "bytes=abc-"}
        )
        self.assertEqual(status, 206)
        self.assertEqual(len(body), CAP)

    def test_small_media_without_range_is_whole_200(self):
        status, headers, body = self._get(f"/w/{ZIM}/v/small.mp4")
        self.assertEqual(status, 200)
        self.assertEqual(body, SMALL)
        self.assertEqual(headers.get("Accept-Ranges"), "bytes")
        self.assertIsNone(headers.get("Content-Range"))

    def test_ogg_counts_as_streamable(self):
        status, _headers, body = self._get(f"/w/{ZIM}/a/big.ogg")
        self.assertEqual(status, 206)
        self.assertEqual(len(body), CAP)

    # ── non-streamable ─────────────────────────────────────────────────────

    def test_over_cap_pdf_is_413_without_reading_content(self):
        status, _headers, body = self._get(f"/w/{ZIM}/d/huge.pdf")
        self.assertEqual(status, 413)
        self.assertIn(b"too large", body.lower())

    def test_over_cap_epub_is_413_without_reading_content(self):
        status, _headers, body = self._get(f"/w/{ZIM}/b/huge.epub")
        self.assertEqual(status, 413)
        self.assertIn(b"too large", body.lower())

    def test_small_pdf_still_serves_inline(self):
        status, headers, body = self._get(f"/w/{ZIM}/d/small.pdf")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"%PDF-1.4 tiny")
        self.assertTrue(headers.get("Content-Type", "").startswith("application/pdf"))

    def test_small_article_still_serves_whole(self):
        status, headers, body = self._get(f"/w/{ZIM}/A/Page")
        self.assertEqual(status, 200)
        self.assertIn(b"hi", body)
        self.assertTrue(headers.get("Content-Type", "").startswith("text/html"))

    # ── caching semantics ──────────────────────────────────────────────────

    def test_etag_304_still_short_circuits(self):
        status, headers, _body = self._get(f"/w/{ZIM}/A/Page")
        self.assertEqual(status, 200)
        etag = headers.get("ETag")
        self.assertTrue(etag)
        status2, _h2, body2 = self._get(f"/w/{ZIM}/A/Page", {"If-None-Match": etag})
        self.assertEqual(status2, 304)
        self.assertEqual(body2, b"")

    def test_etag_304_applies_to_capped_media_too(self):
        _s, headers, _b = self._get(f"/w/{ZIM}/v/big.mp4")
        etag = headers.get("ETag")
        self.assertTrue(etag)
        status, _h, _b = self._get(f"/w/{ZIM}/v/big.mp4", {"If-None-Match": etag})
        self.assertEqual(status, 304)

    def test_missing_entry_still_404s(self):
        status, _headers, body = self._get(f"/w/{ZIM}/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", json.loads(body))


if __name__ == "__main__":
    unittest.main()
