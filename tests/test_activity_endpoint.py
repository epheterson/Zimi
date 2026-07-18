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
        _get_title_index_stats (which walks _TITLE_INDEX_DIR and opens SQLite
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
