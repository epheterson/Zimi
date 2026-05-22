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

    def test_returns_expected_keys(self):
        with (
            mock.patch.object(
                _srv,
                "_get_title_index_stats",
                return_value={
                    "state": "idle",
                    "ready": 0,
                    "total": 0,
                    "building_now": None,
                },
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

    def test_counts_active_downloads(self):
        downloads = [
            {"done": False, "paused": False, "status": "downloading"},
            {"done": False, "paused": False, "status": "downloading"},
            {"done": True, "paused": False, "status": "complete"},
            {"done": False, "paused": True, "status": "paused"},
            {"done": False, "paused": False, "status": "queued"},
        ]
        with (
            mock.patch.object(
                _srv,
                "_get_title_index_stats",
                return_value={
                    "state": "idle",
                    "ready": 0,
                    "total": 0,
                    "building_now": None,
                },
            ),
            mock.patch.object(_srv, "_get_downloads", return_value=downloads),
        ):
            status, body = self._call()
        self.assertEqual(status, 200)
        # 3 not-done not-paused: 2 downloading + 1 queued.
        self.assertEqual(body["downloads"]["active"], 3)
        self.assertEqual(body["downloads"]["queued"], 1)

    def test_indexing_passthrough(self):
        with (
            mock.patch.object(
                _srv,
                "_get_title_index_stats",
                return_value={
                    "state": "building",
                    "ready": 234,
                    "total": 1067,
                    "building_now": "wikipedia_en_all_maxi",
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


if __name__ == "__main__":
    unittest.main()
