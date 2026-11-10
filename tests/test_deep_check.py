"""Manage's deep check: every book's checksum, read in the background.

The quick Check opens each book; the deep one reads every byte (zimcheck.
checksum_problem), so it reports progress in bytes and by book, can be
stopped, and runs one at a time. Failed books land in the same report rows
as the quick Check's."""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import health, zimcheck, zimparts  # noqa: E402
from test_checksum_check import _flip, _Video  # noqa: E402


def _wait(pred, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


class _Lib(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-deep-")
        self.zdir = os.path.join(self.tmp, "zims")
        os.makedirs(self.zdir)
        self.good = build_fixture_zim(
            os.path.join(self.zdir, "good_en_all_2026-01.zim")
        )
        self.bad = build_fixture_zim(os.path.join(self.zdir, "bad_en_all_2026-01.zim"))
        _flip(self.bad, os.path.getsize(self.bad) // 2)
        self._saved = (server.ZIM_DIR, server.ZIMI_DATA_DIR, server.ZIMI_MANAGE)
        server.ZIM_DIR = self.zdir
        server.ZIMI_DATA_DIR = os.path.join(self.tmp, "data")
        os.makedirs(server.ZIMI_DATA_DIR)
        server.ZIMI_MANAGE = True
        server._zim_files_cache = None
        server._zim_list_cache = None
        server.load_cache(force=True)

    def tearDown(self):
        health.cancel_check()
        _wait(lambda: health.get_state()["phase"] != "running")
        server.ZIM_DIR, server.ZIMI_DATA_DIR, server.ZIMI_MANAGE = self._saved
        server._zim_files_cache = None
        server._zim_list_cache = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _big(self, mb=96):
        path = os.path.join(self.zdir, "big_en_all_2026-01.zim")
        from libzim.writer import Creator

        chunk = os.urandom(8 << 20)
        with Creator(path).config_indexing(False, "eng") as c:
            c.set_mainpath("v/0.webm")
            for i in range(mb // 8):
                c.add_item(_Video(i, chunk[: len(chunk) - i]))
            c.add_metadata("Title", "big")
        server._zim_files_cache = None
        server._zim_list_cache = None
        server.load_cache(force=True)
        return path


class TestDeepRun(_Lib):
    def test_it_counts_bytes_and_names_the_failed_book(self):
        started, _ = health.start_check(deep=True)
        self.assertTrue(started)
        self.assertTrue(_wait(lambda: health.get_state()["phase"] == "done"))
        st = health.get_state()
        total = zimparts.size(self.good) + zimparts.size(self.bad)
        self.assertTrue(st["deep"])
        self.assertEqual(st["bytes_total"], total)
        self.assertEqual(st["bytes_done"], total)
        rows = {r["name"]: r for r in st["report"]}
        self.assertIn(zimcheck.CHECKSUM_MISMATCH, rows["bad"]["issues"])
        self.assertEqual(rows["good"]["status"], "ok")

    def test_the_quick_check_carries_no_byte_count(self):
        health.start_check()
        self.assertTrue(_wait(lambda: health.get_state()["phase"] == "done"))
        self.assertFalse(health.get_state()["deep"])

    def test_one_at_a_time_and_it_can_be_stopped(self):
        self._big()
        self.assertTrue(health.start_check(deep=True)[0])
        self.assertTrue(_wait(lambda: health.get_state().get("current")))
        self.assertFalse(health.start_check(deep=True)[0])
        self.assertFalse(health.start_check()[0])
        self.assertTrue(health.cancel_check())
        self.assertTrue(_wait(lambda: health.get_state()["phase"] == "cancelled", 10))
        self.assertLess(
            health.get_state()["bytes_done"], health.get_state()["bytes_total"]
        )
        self.assertTrue(health.start_check()[0])  # the lock was let go

    def test_a_stopped_check_keeps_the_failed_books_and_how_far_it_got(self):
        self._big()  # read after "bad" and before "good"
        real = health._count_bytes

        def slow(n):
            time.sleep(0.05)
            real(n)

        health._count_bytes = slow
        try:
            health.start_check(deep=True)
            self.assertTrue(_wait(lambda: health.get_state().get("current") == "big"))
            health.cancel_check()
            self.assertTrue(
                _wait(lambda: health.get_state()["phase"] == "cancelled", 10)
            )
        finally:
            health._count_bytes = real
        st = health.get_state()
        rows = {r["name"]: r for r in st["report"]}
        self.assertEqual(list(rows), ["bad"])
        self.assertIn(zimcheck.CHECKSUM_MISMATCH, rows["bad"]["issues"])
        self.assertEqual(
            st["summary"], {"total": 1, "healthy": 0, "warnings": 1, "of": 3}
        )

    def test_a_running_check_says_which_book_and_how_long_is_left(self):
        self._big()
        health.start_check(deep=True)
        self.assertTrue(_wait(lambda: health.get_state().get("bytes_done", 0) > 0))
        st = health.get_state()
        self.assertTrue(st["current"])
        self.assertGreaterEqual(st["eta_seconds"], 0)


class TestRoute(_Lib):
    def setUp(self):
        super().setUp()
        from http.server import ThreadingHTTPServer

        from zimi.http import ZimHandler
        from zimi.manage import _generate_api_token

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        self._base = f"http://127.0.0.1:{self._srv.server_address[1]}"
        self._token = _generate_api_token()

    def tearDown(self):
        super().tearDown()
        self._srv.shutdown()
        self._srv.server_close()

    def _post(self, payload):
        req = urllib.request.Request(
            self._base + "/manage/health-check",
            data=json.dumps(payload).encode(),
            method="POST",
        )
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_start_and_cancel_through_the_route(self):
        self._big()
        st, _ = self._post({"deep": True})
        self.assertEqual(st, 200)
        self.assertTrue(_wait(lambda: health.get_state().get("current")))
        st, body = self._post({"cancel": True})
        self.assertEqual(st, 200)
        self.assertTrue(_wait(lambda: health.get_state()["phase"] == "cancelled", 10))


if __name__ == "__main__":
    unittest.main()
