"""Entries over the 50 MB cap that are not audio or video: a big PDF in a
document library, a big zip.

They were refused outright (MAX_SERVE_BYTES). An entry stored uncompressed
is one run of bytes in the file (zimblob), so it is now sent in pieces:
8 MB windows by Range, or the whole of it window by window without one,
read with pread and never held whole. An entry in a compressed cluster can
only be had by loading all of it, so over the cap it is still refused, in
words that say why.

The fixture is a real three-page PDF padded past the cap with an unused
stream of random bytes, written once uncompressed and once compressed.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.writer import Creator, Hint, Item, StringProvider  # noqa: E402

import zimi.server as server  # noqa: E402

MB = 1 << 20
PAD = 52 * MB  # past the 50 MB cap


def big_pdf(pad=PAD, pages=3):
    """A valid PDF of ``pages`` pages of text, padded with an unreferenced
    stream of ``pad`` random bytes. Offsets in the xref are exact."""
    objs = []
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(pages))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode())
    for i in range(pages):
        text = f"BT /F1 36 Tf 72 700 Td (Page {i + 1}) Tj ET".encode()
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R "
            f"/Resources << /Font << /F1 {3 + 2 * pages} 0 R >> >> >>".encode()
        )
        objs.append(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    padding = os.urandom(pad)
    objs.append(b"<< /Length %d >>\nstream\n" % len(padding) + padding + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1,
        xref,
    )
    return bytes(out)


class _Doc(Item):
    def __init__(self, path, mime, data, compress):
        super().__init__()
        self.p, self.m, self.d, self.c = path, mime, data, compress

    def get_path(self):
        return self.p

    def get_title(self):
        return os.path.basename(self.p)

    def get_mimetype(self):
        return self.m

    def get_contentprovider(self):
        return StringProvider(self.d)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: False, Hint.COMPRESS: self.c}


def build_library(folder):
    """Two ZIMs holding the same big PDF: ``plain`` uncompressed, ``packed``
    compressed. Returns the PDF's bytes."""
    pdf = big_pdf()
    for name, compress in (("plain", False), ("packed", True)):
        with Creator(
            os.path.join(folder, f"{name}_en_all_2026-01.zim")
        ).config_indexing(False, "eng") as c:
            c.set_mainpath("A/Index")
            c.add_item(
                _Doc("A/Index", "text/html", b"<html><body>docs</body></html>", True)
            )
            c.add_item(_Doc("files/manual.pdf", "application/pdf", pdf, compress))
            c.add_metadata("Title", name)
    return pdf


def _rss_kb(pid):
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True
    )
    return int(out.stdout.strip() or 0)


class TestBigEntries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        from zimi.http import ZimHandler

        cls._tmp = tempfile.mkdtemp(prefix="zimi-big-")
        zdir = os.path.join(cls._tmp, "zims")
        os.makedirs(zdir)
        cls.pdf = build_library(zdir)
        cls._saved = (server.ZIM_DIR, server.ZIMI_DATA_DIR)
        server.ZIM_DIR = zdir
        server.ZIMI_DATA_DIR = os.path.join(cls._tmp, "data")
        os.makedirs(server.ZIMI_DATA_DIR)
        server._zim_files_cache = None
        server._zim_list_cache = None
        server.load_cache(force=True)
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls._srv.shutdown()
        cls._srv.server_close()
        server.ZIM_DIR, server.ZIMI_DATA_DIR = cls._saved
        server._zim_files_cache = None
        server._zim_list_cache = None
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _req(self, path, method="GET", headers=None, read=True):
        req = urllib.request.Request(
            self._base + path, method=method, headers=headers or {}
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, dict(r.headers), (r.read() if read else b"")
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_the_fixture_is_over_the_cap(self):
        self.assertGreater(len(self.pdf), server.MAX_SERVE_BYTES)

    def test_a_plain_download_gets_every_byte(self):
        st, h, body = self._req("/w/plain/files/manual.pdf")
        self.assertEqual(st, 200)
        self.assertEqual(int(h["Content-Length"]), len(self.pdf))
        self.assertEqual(h["Accept-Ranges"], "bytes")
        self.assertNotIn("Content-Encoding", h)
        self.assertEqual(body, self.pdf)

    def test_a_range_gets_those_bytes(self):
        st, h, body = self._req(
            "/w/plain/files/manual.pdf", headers={"Range": "bytes=100-199"}
        )
        self.assertEqual(st, 206)
        self.assertEqual(h["Content-Range"], f"bytes 100-199/{len(self.pdf)}")
        self.assertEqual(body, self.pdf[100:200])

    def test_an_open_range_is_one_window(self):
        st, h, body = self._req(
            "/w/plain/files/manual.pdf", headers={"Range": "bytes=0-"}
        )
        self.assertEqual(st, 206)
        end = server.STREAM_WINDOW_BYTES - 1
        self.assertEqual(h["Content-Range"], f"bytes 0-{end}/{len(self.pdf)}")
        self.assertEqual(body, self.pdf[: end + 1])

    def test_head_says_what_get_would(self):
        st, h, body = self._req("/w/plain/files/manual.pdf", method="HEAD")
        self.assertEqual(st, 200)
        self.assertEqual(h["Content-Type"], "application/pdf")
        self.assertEqual(int(h["Content-Length"]), len(self.pdf))
        self.assertEqual(h["Accept-Ranges"], "bytes")
        self.assertEqual(body, b"")

    def test_a_compressed_one_is_refused_in_words(self):
        st, h, body = self._req("/w/packed/files/manual.pdf")
        self.assertEqual(st, 413)
        self.assertIn(b"stored compressed", body)

    @unittest.skipIf(os.name == "nt", "ps measures memory here")
    def test_memory_does_not_grow_by_the_file(self):
        pid = os.getpid()
        before = _rss_kb(pid)
        peak = [before]
        done = threading.Event()

        def sample():
            while not done.is_set():
                peak[0] = max(peak[0], _rss_kb(pid))
                time.sleep(0.05)

        threading.Thread(target=sample, daemon=True).start()
        req = urllib.request.Request(self._base + "/w/plain/files/manual.pdf")
        got = 0
        with urllib.request.urlopen(req, timeout=60) as r:
            while True:
                block = r.read(MB)  # the client keeps nothing either
                if not block:
                    break
                got += len(block)
        done.set()
        self.assertEqual(got, len(self.pdf))
        grew_mb = (peak[0] - before) / 1024
        self.assertLess(grew_mb, len(self.pdf) / MB / 2, f"grew {grew_mb:.0f} MB")


if __name__ == "__main__":
    unittest.main()
