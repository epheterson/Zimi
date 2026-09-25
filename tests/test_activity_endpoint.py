"""/manage/activity shape contract: small aggregate for the topbar status row.

Must stay cheap (no I/O), must return the same keys regardless of state so
the client renders predictably."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401  (forces module init via __init__ proxy)
from zimi import manage as _manage  # noqa: E402
from zimi import server as _srv  # noqa: E402


class _Handler:
    """Minimal handler stub that captures _json() calls."""

    def __init__(self):
        self.status = None
        self.body = None
        self.headers = {}

    def _is_private_client(self):
        return True  # tests act as a LAN client

    def _json(self, status, body):
        self.status = status
        self.body = body
        return None


class ActivityEndpointTests(unittest.TestCase):
    def _call(self):
        """Invoke handle_manage_get with /manage/activity and return body."""
        h = _Handler()
        # urlparse stub — only .path is read by the handler dispatch
        from urllib.parse import urlparse

        parsed = urlparse("/manage/activity")

        def _param(key, default=""):
            return default

        # Call the dispatcher's matching branch directly by re-implementing
        # what handle_manage_get does for activity, since the real one is
        # tied to a full request object.
        _manage.handle_manage_get(h, parsed, _param)
        return h.status, h.body

    def _idle_status(self):
        return {
            "state": "idle",
            "ready": 0,
            "total": 0,
            "building_now": None,
            "errors": [],
        }

    def test_returns_expected_keys(self):
        with (
            mock.patch.object(
                _srv, "_get_title_index_status_brief", return_value=self._idle_status()
            ),
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
        ):
            status, body = self._call()
        self.assertEqual(status, 200)
        self.assertIn("indexing", body)
        self.assertIn("downloads", body)
        self.assertIn("seeding", body)
        self.assertIn("state", body["indexing"])
        self.assertIn("ready", body["indexing"])
        self.assertIn("total", body["indexing"])
        self.assertIn("current", body["indexing"])
        self.assertIn("active", body["downloads"])
        self.assertIn("queued", body["downloads"])
        self.assertIn("torrents", body["seeding"])
        # Background jobs (bookmark→ZIM export, library health check) ride
        # along as brief {phase, done, total} snapshots — same keys idle or not.
        for op in ("export", "health"):
            self.assertIn(op, body)
            self.assertIn("phase", body[op])
            self.assertIn("done", body[op])
            self.assertIn("total", body[op])

    def test_export_and_health_passthrough(self):
        """Running export/health state surfaces as phase/done/total briefs;
        health's heavy `report` payload must NOT be forwarded on a 5s poll."""
        from zimi import health as _health
        from zimi import zimwriter as _zw

        export_state = {
            "phase": "running",
            "done": 3,
            "total": 9,
            "file": None,
            "files": [],
            "count": 3,
            "error": None,
        }
        health_state = {
            "phase": "running",
            "done": 12,
            "total": 53,
            "report": [{"name": "big"}] * 53,
            "summary": None,
        }
        with (
            mock.patch.object(
                _srv, "_get_title_index_status_brief", return_value=self._idle_status()
            ),
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
            mock.patch.object(_zw, "get_export_state", return_value=export_state),
            mock.patch.object(_health, "get_state", return_value=health_state),
        ):
            status, body = self._call()
        self.assertEqual(status, 200)
        self.assertEqual(body["export"], {"phase": "running", "done": 3, "total": 9})
        self.assertEqual(body["health"], {"phase": "running", "done": 12, "total": 53})
        self.assertNotIn("report", body["health"])
        self.assertNotIn("files", body["export"])

    def test_counts_match_real_download_shape(self):
        """Mirrors the actual fields _get_downloads() returns (library.py:1209,
        1234): in-flight items get queued=False, queued items get queued=True.
        Earlier draft of the endpoint filtered on a non-existent `status` key
        and silently always returned queued=0 — this locks the contract in."""
        downloads = [
            # in-flight
            {"done": False, "paused": False, "queued": False},
            {"done": False, "paused": False, "queued": False},
            # finished
            {"done": True, "paused": False, "queued": False},
            # paused
            {"done": False, "paused": True, "queued": False},
            # queued (waiting for a slot)
            {"done": False, "paused": False, "queued": True},
            {"done": False, "paused": False, "queued": True},
        ]
        with (
            mock.patch.object(
                _srv, "_get_title_index_status_brief", return_value=self._idle_status()
            ),
            mock.patch.object(_srv, "_get_downloads", return_value=downloads),
        ):
            status, body = self._call()
        self.assertEqual(status, 200)
        # active = in-flight only (excludes done, paused, AND queued)
        self.assertEqual(body["downloads"]["active"], 2)
        # queued = items with queued=True
        self.assertEqual(body["downloads"]["queued"], 2)

    def test_indexing_passthrough(self):
        with (
            mock.patch.object(
                _srv,
                "_get_title_index_status_brief",
                return_value={
                    "state": "building",
                    "ready": 234,
                    "total": 1067,
                    "building_now": "wikipedia_en_all_maxi",
                    "errors": [],
                },
            ),
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
        ):
            status, body = self._call()
        self.assertEqual(status, 200)
        self.assertEqual(body["indexing"]["state"], "building")
        self.assertEqual(body["indexing"]["ready"], 234)
        self.assertEqual(body["indexing"]["total"], 1067)
        self.assertEqual(body["indexing"]["current"], "wikipedia_en_all_maxi")

    def test_endpoint_does_no_disk_walking(self):
        """At 1067 ZIMs polled every 5s, the activity endpoint must not call
        _get_title_index_stats (which walks the title index dir and opens SQLite
        DBs for each entry). It must use the brief in-memory snapshot."""
        with (
            mock.patch.object(
                _srv, "_get_title_index_status_brief", return_value=self._idle_status()
            ) as brief_mock,
            mock.patch.object(_srv, "_get_title_index_stats") as full_mock,
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
        ):
            self._call()
        brief_mock.assert_called_once()
        full_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class BackgroundWorkTests(unittest.TestCase):
    """The Q-ID scan, did-you-mean and ZimiTube details run for minutes to
    hours after a start or an update, and nothing said so. They mark what
    they are on, and the activity poll carries it for Manage to show."""

    def tearDown(self):
        from zimi import search

        for kind in ("qids", "vocab", "tube"):
            search._background_end(kind)

    def test_a_running_job_is_reported_and_an_ended_one_is_not(self):
        from zimi import search

        search._background_start("qids", 12)
        search._background_step("qids", "wikipedia_ru", 3)
        h = ActivityEndpointTests()
        with (
            mock.patch.object(_srv, "_get_title_index_status_brief", return_value=h._idle_status()),
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
        ):
            _, body = h._call()
        # Only this test's job: the suite's own server may be building its
        # did-you-mean vocabulary at the same moment, which is the point.
        jobs = [j for j in body["background"] if j["kind"] == "qids"]
        self.assertEqual([(j["kind"], j["current"], j["done"], j["total"]) for j in jobs],
                         [("qids", "wikipedia_ru", 3, 12)])

        search._background_end("qids")
        with (
            mock.patch.object(_srv, "_get_title_index_status_brief", return_value=h._idle_status()),
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
        ):
            _, body = h._call()
        self.assertEqual([j for j in body["background"] if j["kind"] == "qids"], [])

    def test_the_vocabulary_build_marks_itself_and_always_clears(self):
        from zimi import search

        seen = []
        with mock.patch.object(search, "_vocab_build_worker_inner",
                               side_effect=lambda attempt: seen.append(search.background_work())):
            search._vocab_build_worker()
        self.assertIn("vocab", [j["kind"] for j in seen[0]])
        self.assertNotIn("vocab", [j["kind"] for j in search.background_work()])

        with mock.patch.object(search, "_vocab_build_worker_inner", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                search._vocab_build_worker()
        self.assertNotIn("vocab", [j["kind"] for j in search.background_work()],
                         "a failed build must not read as running forever")


class FailuresAreReported(unittest.TestCase):
    """Manage said "every index is up to date" while a rebuild had failed and
    the ZIM kept its old index. Failures ride on the activity poll until a
    later build of the same ZIM succeeds."""

    def tearDown(self):
        from zimi import search

        for kind in ("qids", "tube", "vocab"):
            search._background_failed.pop(kind, None)

    def test_a_failed_build_is_reported_until_it_succeeds(self):
        from zimi import search

        search._background_fail("qids", "wikipedia_ru")
        h = ActivityEndpointTests()
        status = h._idle_status()
        status["errors"] = [("wikipedia", "child exited -9")]
        with (
            mock.patch.object(_srv, "_get_title_index_status_brief", return_value=status),
            mock.patch.object(_srv, "_get_downloads", return_value=[]),
        ):
            _, body = h._call()
        self.assertEqual(body["indexing"]["failed"], ["wikipedia"])
        self.assertIn({"kind": "qids", "name": "wikipedia_ru"}, body["failed"])

        search._background_ok("qids", "wikipedia_ru")
        self.assertNotIn({"kind": "qids", "name": "wikipedia_ru"}, search.background_failures())
