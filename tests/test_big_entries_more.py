"""Big entries past the cap, the rest of the cases: an EPUB, and a split
book whose entry may cross a chunk boundary.

The cap is lowered to 1 MB here so the fixtures stay small; the windows
follow it (min(STREAM_WINDOW_BYTES, MAX_SERVE_BYTES)), so a 3 MB entry is
sent in three pieces and a 1 MB chunk boundary falls inside it."""

import io
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.writer import Creator  # noqa: E402

from conftest_zim import split_fixture_zim  # noqa: E402
from test_big_entries import _Doc, big_pdf  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import epub  # noqa: E402

MB = 1 << 20
CAP = 1 * MB
PAD = 3 * MB


def big_epub(pad=PAD):
    """A one-chapter EPUB with an unused member of ``pad`` random bytes,
    stored (not deflated) so the zip is as big as its contents."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        z.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Big Book</dc:title><dc:identifier id="id">x</dc:identifier>'
            "<dc:language>en</dc:language></metadata>"
            '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="pad" href="pad.bin" media-type="application/octet-stream"/></manifest>'
            '<spine><itemref idref="c1"/></spine></package>',
        )
        z.writestr(
            "OEBPS/c1.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter one</h1><p>The river ran north.</p></body></html>',
        )
        z.writestr("OEBPS/pad.bin", os.urandom(pad))
    return buf.getvalue()


def _build(path, files, compress):
    with Creator(path).config_indexing(False, "eng") as c:
        c.set_mainpath("A/Index")
        c.add_item(
            _Doc("A/Index", "text/html", b"<html><body>docs</body></html>", True)
        )
        for p, (mime, data) in files.items():
            c.add_item(_Doc(p, mime, data, compress))
        c.add_metadata("Title", os.path.basename(path))
    return path


class TestMore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        from zimi.http import ZimHandler

        cls._tmp = tempfile.mkdtemp(prefix="zimi-big2-")
        zdir = os.path.join(cls._tmp, "zims")
        os.makedirs(zdir)
        cls.pdf, cls.epub = big_pdf(PAD), big_epub()
        files = {
            "files/manual.pdf": ("application/pdf", cls.pdf),
            "files/book.epub": ("application/epub+zip", cls.epub),
        }
        _build(os.path.join(zdir, "plain_en_all_2026-01.zim"), files, False)
        _build(os.path.join(zdir, "packed_en_all_2026-01.zim"), files, True)
        # Cut every MB the way `split -b` does: the entries cross boundaries.
        cls.chunks = split_fixture_zim(
            _build(os.path.join(zdir, "cut_en_all_2026-01.zim"), files, False),
            CAP,
            aligned=False,
        )
        cls._saved = (server.ZIM_DIR, server.ZIMI_DATA_DIR, server.MAX_SERVE_BYTES)
        server.ZIM_DIR = zdir
        server.ZIMI_DATA_DIR = os.path.join(cls._tmp, "data")
        server.MAX_SERVE_BYTES = CAP
        os.makedirs(server.ZIMI_DATA_DIR)
        server._zim_files_cache = None
        server._zim_list_cache = None
        server.load_cache(force=True)
        epub._reset_for_tests()
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls._srv.shutdown()
        cls._srv.server_close()
        server.ZIM_DIR, server.ZIMI_DATA_DIR, server.MAX_SERVE_BYTES = cls._saved
        server._zim_files_cache = None
        server._zim_list_cache = None
        epub._reset_for_tests()
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _get(self, path, headers=None):
        req = urllib.request.Request(self._base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_the_fixtures_are_over_the_cap_and_cross_chunks(self):
        self.assertGreater(len(self.epub), CAP)
        self.assertGreater(len(self.chunks), 3)

    def test_an_uncompressed_epub_downloads_whole(self):
        st, h, body = self._get("/w/plain/files/book.epub?raw=1")
        self.assertEqual(st, 200)
        self.assertIn("attachment", h["Content-Disposition"])
        self.assertEqual(body, self.epub)

    def test_the_epub_reader_opens_an_uncompressed_one(self):
        st, h, body = self._get(
            "/w/plain/files/book.epub/", {"Sec-Fetch-Dest": "iframe"}
        )
        self.assertEqual(st, 200)
        self.assertIn(b"The river ran north", body)

    def test_a_compressed_epub_is_refused_for_the_true_reason(self):
        st, h, body = self._get("/w/packed/files/book.epub?raw=1")
        self.assertEqual(st, 413)
        self.assertIn(b"stored compressed", body)

    def test_a_big_entry_of_a_split_book_crosses_chunks(self):
        st, h, body = self._get("/w/cut/files/manual.pdf")
        self.assertEqual(st, 200)
        self.assertEqual(body, self.pdf)
        st, h, body = self._get(
            "/w/cut/files/manual.pdf", {"Range": f"bytes={CAP - 10}-{CAP + 9}"}
        )
        self.assertEqual(st, 206)
        self.assertEqual(body, self.pdf[CAP - 10 : CAP + 10])

    def test_the_epub_reader_opens_one_in_a_split_book(self):
        st, h, body = self._get("/w/cut/files/book.epub/", {"Sec-Fetch-Dest": "iframe"})
        self.assertEqual(st, 200)
        self.assertIn(b"The river ran north", body)


class TestWhy(unittest.TestCase):
    def test_find_says_compressed_only_when_it_is(self):
        from libzim.reader import Archive

        from zimi import zimblob

        tmp = tempfile.mkdtemp(prefix="zimi-why-")
        try:
            files = {"files/manual.pdf": ("application/pdf", big_pdf(64 * 1024))}
            for name, compress in (("plain", False), ("packed", True)):
                path = _build(os.path.join(tmp, f"{name}.zim"), files, compress)
                item = Archive(path).get_entry_by_path("files/manual.pdf").get_item()
                at, why = zimblob.find(path, item._index, item.size)
                self.assertEqual(why, zimblob.COMPRESSED if compress else None)
                if not compress:
                    self.assertEqual(
                        zimblob.find(path, item._index, item.size + 1),
                        (None, zimblob.UNREADABLE),
                    )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
