"""A book's icon when it has no 48x48 illustration.

openZIM makes Illustration_48x48@1 mandatory, but books exist with only a
larger one (96x96, 144x144...) or only a smaller one. The library used to say
"no icon" for them. The icon is now the nearest size the book carries: the
smallest at or above 48, else the largest below it, served at the same
address with the same caching as the 48."""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.writer import Creator  # noqa: E402

from conftest_zim import _Article, solid_png  # noqa: E402
import zimi.server as server  # noqa: E402

# name -> {size: colour}; each size gets its own colour so the test can tell
# which one was served.
BOOKS = {
    "only96": {96: (10, 20, 30)},
    "onlysmall": {16: (40, 50, 60), 32: (70, 80, 90)},
    "several": {144: (1, 2, 3), 64: (4, 5, 6), 256: (7, 8, 9)},
    "has48": {48: (11, 12, 13), 96: (14, 15, 16)},
    "none": {},
}
EXPECTED = {"only96": 96, "onlysmall": 32, "several": 64, "has48": 48}


def _build(path, sizes):
    with Creator(path).config_indexing(False, "eng") as c:
        c.set_mainpath("A/Page")
        c.add_item(_Article("A/Page", "Page", b"<html><body>page</body></html>"))
        for key, value in (
            ("Title", "Icons"),
            ("Language", "eng"),
            ("Description", "icons"),
        ):
            c.add_metadata(key, value)
        for size, colour in sizes.items():
            c.add_illustration(size, solid_png(size, size, colour))
    return path


class TestIllustrations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        from zimi.http import ZimHandler

        cls._tmp = tempfile.mkdtemp(prefix="zimi-icons-")
        zdir = os.path.join(cls._tmp, "zims")
        os.makedirs(zdir)
        for name, sizes in BOOKS.items():
            _build(os.path.join(zdir, f"{name}_en_all_2026-01.zim"), sizes)
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

    def _get(self, path, headers=None):
        req = urllib.request.Request(self._base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_the_library_says_every_book_with_any_illustration_has_an_icon(self):
        rows = {z["name"]: z for z in server.list_zims()}
        for name in EXPECTED:
            self.assertTrue(rows[name]["has_icon"], name)
        self.assertFalse(rows["none"]["has_icon"])

    def test_the_nearest_size_is_served(self):
        for name, size in EXPECTED.items():
            st, _h, body = self._get(f"/w/{name}/-/icon")
            self.assertEqual(st, 200, name)
            self.assertEqual(body, solid_png(size, size, BOOKS[name][size]), name)

    def test_it_is_cached_the_way_the_48_is(self):
        st, h48, _ = self._get("/w/has48/-/icon")
        st, h96, _ = self._get("/w/only96/-/icon")
        self.assertEqual(h96["Cache-Control"], h48["Cache-Control"])
        st, _h, body = self._get("/w/only96/-/icon", {"If-None-Match": h96["ETag"]})
        self.assertEqual(st, 304)

    def test_a_cache_record_from_when_only_48_counted_is_read_again(self):
        cf = server._cache_file_path()
        with open(cf) as f:
            data = json.load(f)
        for rec in data["files"].values():
            rec.pop("icon_v", None)
            rec["has_icon"] = (
                rec["file"].startswith("has48") if "file" in rec else False
            )
        with open(cf, "w") as f:
            json.dump(data, f)
        server._zim_list_cache = None
        server.load_cache(force=False)
        rows = {z["name"]: z for z in server.list_zims()}
        self.assertTrue(rows["only96"]["has_icon"])
        self.assertFalse(rows["none"]["has_icon"])

    def test_a_book_without_any_illustration_still_has_none(self):
        st, h, _ = self._get("/w/none/-/icon")
        self.assertEqual(st, 404)
        self.assertEqual(h["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()
