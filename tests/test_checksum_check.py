"""The ZIM checksum, verified once for `zimi check` and Manage's Check.

libzim's own Archive.check() reads the whole file holding Python's GIL: on a
1 GB file every other thread of the server stood still for the seven seconds
it took (2 ticks of a 1 ms timer). zimcheck.checksum_problem streams the
file (every chunk of a split book) through hashlib, which lets go of the GIL,
and touches neither libzim nor its lock. libzim is the oracle here."""

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.reader import Archive  # noqa: E402
from libzim.writer import Creator, Hint, Item, StringProvider  # noqa: E402

from conftest_zim import build_fixture_zim, split_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import health, zimcheck  # noqa: E402


def _flip(path, offset):
    with open(path, "r+b") as f:
        f.seek(offset)
        b = f.read(1)
        f.seek(offset)
        f.write(bytes([b[0] ^ 0xFF]))


class _Video(Item):
    def __init__(self, i, data):
        super().__init__()
        self.i, self.data = i, data

    def get_path(self):
        return f"v/{self.i}.webm"

    def get_title(self):
        return ""

    def get_mimetype(self):
        return "video/webm"

    def get_contentprovider(self):
        return StringProvider(self.data)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: False, Hint.COMPRESS: False}


class TestChecksum(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-cksum-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_whole_file_agrees_with_libzim(self):
        good = build_fixture_zim(os.path.join(self.tmp, "good_en_all_2026-01.zim"))
        bad = build_fixture_zim(os.path.join(self.tmp, "bad_en_all_2026-01.zim"))
        _flip(bad, os.path.getsize(bad) // 2)
        self.assertTrue(Archive(good).check())
        self.assertFalse(Archive(bad).check())
        self.assertIsNone(zimcheck.checksum_problem(good))
        self.assertEqual(
            zimcheck.checksum_problem(bad), "the file does not match its own checksum"
        )

    def test_every_chunk_of_a_split_book_is_read(self):
        chunks = split_fixture_zim(
            build_fixture_zim(os.path.join(self.tmp, "s_en_all_2026-01.zim")), 100
        )
        self.assertIsNone(zimcheck.checksum_problem(chunks[0]))
        _flip(chunks[2], os.path.getsize(chunks[2]) // 2)
        self.assertFalse(Archive(chunks[0]).check())
        self.assertEqual(
            zimcheck.checksum_problem(chunks[0]),
            "the file does not match its own checksum",
        )

    def test_zimi_check_reports_it(self):
        bad = build_fixture_zim(os.path.join(self.tmp, "bad_en_all_2026-01.zim"))
        _flip(bad, os.path.getsize(bad) // 2)
        found = [f for f in zimcheck.check(bad) if f["check"] == "checksum"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["level"], zimcheck.ERROR)

    def test_it_takes_neither_the_libzim_lock_nor_the_gil(self):
        path = os.path.join(self.tmp, "big_en_all_2026-01.zim")
        chunk = os.urandom(8 << 20)
        with Creator(path).config_indexing(False, "eng") as c:
            c.set_mainpath("v/0.webm")
            for i in range(12):  # ~96 MB
                c.add_item(_Video(i, chunk[: len(chunk) - i]))
            c.add_metadata("Title", "big")
        ticks, done, result = [0], threading.Event(), []

        def run():
            try:
                result.append(zimcheck.checksum_problem(path))
            finally:
                done.set()

        with server._zim_lock:  # held throughout: the check must not need it
            t0 = time.time()
            threading.Thread(target=run, daemon=True).start()
            while not done.wait(0.001):
                ticks[0] += 1
            elapsed = time.time() - t0
        self.assertEqual(result, [None])
        # This thread kept running while the file was read: at least a few
        # hundred wakeups a second (libzim's check gave 2 in 7 s).
        self.assertGreater(ticks[0], elapsed * 200, (ticks[0], elapsed))


class TestHealthDeep(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-cksum-")
        self.bad = build_fixture_zim(os.path.join(self.tmp, "bad_en_all_2026-01.zim"))
        _flip(self.bad, os.path.getsize(self.bad) // 2)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_deep_check_reports_a_bad_checksum(self):
        row = health._check_one({"name": "bad"}, self.bad, {}, deep=True)
        self.assertIn("the file does not match its own checksum", row["issues"])
        self.assertEqual(row["status"], "warn")

    def test_the_quick_check_does_not_read_the_whole_file(self):
        row = health._check_one({"name": "bad"}, self.bad, {})
        self.assertNotIn("the file does not match its own checksum", row["issues"])


if __name__ == "__main__":
    unittest.main()
