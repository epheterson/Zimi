#!/usr/bin/env python3
"""A video's bytes come from the file, not from libzim under _zim_lock.

python-libzim has no partial read: ``item.content`` maps the whole entry.
Every range a player asked for used to map all of it (65 MB for a TED
talk on the NAS) while holding the lock every search and article read
waits on; on a cold disk that stalled the whole server once per range.
zimblob finds an uncompressed entry's run in the file and /w/ reads its
windows with os.pread, outside the lock.
"""

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.reader import Archive  # noqa: E402
from libzim.writer import Creator  # noqa: E402

import zimi.server as server  # noqa: E402
from zimi import zimblob  # noqa: E402
from conftest_zim import _Article, _MediaItem  # noqa: E402

ZIM = "talks"
VIDEO = bytes(range(256)) * (12 * 1024 * 1024 // 256 + 7)  # just over 12 MB
SMALL = b"\x1aE\xdf\xa3 a short clip"


def _build(path):
    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath("A/Talks")
        c.add_item(
            _Article(
                "A/Talks",
                "Talks",
                b"<html><body><h1>Talks</h1>"
                + b"<p>talk</p>" * 200
                + b"</body></html>",
            )
        )
        c.add_item(_MediaItem("videos/1/video.webm", "video/webm", VIDEO))
        c.add_item(_MediaItem("videos/2/video.webm", "video/webm", SMALL))
        c.add_metadata("Title", "Talks")
        c.add_metadata("Language", "eng")


class TestLocate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dir = tempfile.mkdtemp(prefix="zimi-blob-")
        cls._path = os.path.join(cls._dir, ZIM + ".zim")
        _build(cls._path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._dir, ignore_errors=True)

    def _item(self, path):
        return Archive(self._path).get_entry_by_path(path).get_item()

    def test_media_run_matches_libzim(self):
        it = self._item("videos/1/video.webm")
        at = zimblob.locate(self._path, it._index, it.size)
        self.assertIsNotNone(at)
        mid = it.size // 2
        self.assertEqual(
            zimblob.read(self._path, at, mid, mid + 4095), VIDEO[mid : mid + 4096]
        )
        self.assertEqual(zimblob.read(self._path, at, 0, it.size - 1), VIDEO)

    def test_compressed_entry_is_left_to_libzim(self):
        it = self._item("A/Talks")
        self.assertIsNone(zimblob.locate(self._path, it._index, it.size))

    def test_disagreeing_size_or_bad_input_gives_up(self):
        it = self._item("videos/1/video.webm")
        self.assertIsNone(zimblob.locate(self._path, it._index, it.size + 1))
        self.assertIsNone(zimblob.locate(self._path, None, it.size))
        self.assertIsNone(zimblob.locate(self._path, 10**6, it.size))
        self.assertIsNone(zimblob.locate(self._path + "aa", it._index, it.size))


class TestServeOutsideLock(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        from zimi.http import ZimHandler

        cls._dir = tempfile.mkdtemp(prefix="zimi-direct-")
        _build(os.path.join(cls._dir, ZIM + ".zim"))
        os.environ["ZIM_DIR"] = cls._dir
        server.ZIM_DIR = cls._dir
        server.ZIMI_DATA_DIR = os.path.join(cls._dir, ".zimi")
        os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
        server.load_cache()
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = "http://127.0.0.1:%d" % cls._srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls._srv.shutdown()
        shutil.rmtree(cls._dir, ignore_errors=True)

    def _get(self, path, headers=None, timeout=20):
        req = urllib.request.Request(self._base + path, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers, resp.read()

    def test_ranges_and_whole_file_are_the_right_bytes(self):
        status, headers, body = self._get(
            "/w/%s/videos/1/video.webm" % ZIM, {"Range": "bytes=1000-1999"}
        )
        self.assertEqual((status, body), (206, VIDEO[1000:2000]))
        self.assertEqual(
            headers.get("Content-Range"), "bytes 1000-1999/%d" % len(VIDEO)
        )
        status, _h, body = self._get(
            "/w/%s/videos/1/video.webm" % ZIM, {"Range": "bytes=-77"}
        )
        self.assertEqual((status, body), (206, VIDEO[-77:]))
        status, headers, body = self._get("/w/%s/videos/1/video.webm" % ZIM)
        self.assertEqual(status, 200)
        self.assertEqual(body, VIDEO, "the whole file, windowed")
        status, _h, body = self._get("/w/%s/videos/2/video.webm" % ZIM)
        self.assertEqual((status, body), (200, SMALL))

    def test_slow_media_read_does_not_block_search(self):
        """A cold disk under a video read must not hold up a search."""
        real_read = zimblob.read
        reading = threading.Event()
        held = []

        def slow_read(*args):
            reading.set()
            held.append(server._zim_lock.locked())
            time.sleep(2.0)
            return real_read(*args)

        zimblob.read = slow_read
        try:
            got = {}

            def fetch_video():
                got["video"] = self._get(
                    "/w/%s/videos/1/video.webm" % ZIM, {"Range": "bytes=0-65535"}
                )

            t = threading.Thread(target=fetch_video)
            t.start()
            self.assertTrue(reading.wait(10), "the video read went through zimblob")
            t0 = time.monotonic()
            status, _h, _b = self._get("/search?q=talks&limit=3", timeout=10)
            elapsed = time.monotonic() - t0
            t.join(15)
        finally:
            zimblob.read = real_read
        self.assertEqual(status, 200)
        self.assertLess(
            elapsed, 1.5, "search waited %.2fs behind a video read" % elapsed
        )
        self.assertEqual(held, [False], "the media bytes were read with _zim_lock free")
        self.assertEqual(got["video"][2], VIDEO[:65536])


if __name__ == "__main__":
    unittest.main()


def test_reads_without_os_pread_as_on_windows(tmp_path, monkeypatch):
    """Windows has no os.pread: 1.13.0's first CI run served every video
    there as a 500. The seek-and-read path gives the same bytes."""
    import zimi.zimblob as zimblob

    p = tmp_path / "blob.bin"
    p.write_bytes(bytes(range(256)) * 4)
    monkeypatch.delattr(os, "pread", raising=False)
    assert zimblob.read(str(p), 100, 0, 9) == (bytes(range(256)) * 4)[100:110]
