"""Almanac deep-links: closed-set Q-ID -> installed-article batch resolution.

The almanac ships a curated, CLOSED SET of Wikidata Q-IDs and resolves them
against the installed library in one batch (POST/GET /almanac-links). These
tests cover the server resolver and the endpoint's validation:

  - resolve_almanac_qids: index hits, misses (absent, never a fallback),
    Q-ID format rejection, dedup, language-preference ordering, and the
    no-encyclopedia -> empty case.
  - _almanac_links_response: batch-size cap, type validation, hit shape, and
    that it is an auth-free, rate-limited public read.

The Q-ID index fixture uses the REAL schema from _build_qid_index so these
exercise the same sqlite path production uses.
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401  (forces module init via __init__ proxy)
from zimi import http as _http  # noqa: E402
from zimi import interlang as _interlang  # noqa: E402
from zimi import server as _srv  # noqa: E402


def _make_qid_index(dir_path, zim_name, path_to_qid):
    """Write a minimal Q-ID index matching interlang._build_qid_index's schema."""
    os.makedirs(dir_path, exist_ok=True)
    db_path = os.path.join(dir_path, f"{zim_name}.qid.db")
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE qids (path TEXT PRIMARY KEY, qid INTEGER)")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.executemany("INSERT INTO qids VALUES (?,?)", list(path_to_qid.items()))
    conn.execute("CREATE INDEX idx_qid ON qids(qid)")
    conn.commit()
    conn.close()
    return db_path


class _Handler:
    """Minimal handler stub that captures _json() calls (see other endpoint tests)."""

    def __init__(self):
        self.status = None
        self.body = None

    def _json(self, status, body):
        self.status = status
        self.body = body
        return None


class _QidFixtureMixin:
    def _setup_qids(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-alm-")
        self._patch_dir = mock.patch.object(_interlang, "_QID_INDEX_DIR", self.tmp)
        self._patch_dir.start()
        # Isolate the pooled connections + on-demand cache for the temp dir.
        self._saved_pool = dict(_interlang._qid_db_pool)
        _interlang._qid_db_pool.clear()
        self._saved_cache_conn = _interlang._qid_cache_conn
        _interlang._qid_cache_conn = None
        self._saved_zim_list = _srv._zim_list_cache

    def _teardown_qids(self):
        for conn in _interlang._qid_db_pool.values():
            try:
                conn.close()
            except Exception:
                pass
        _interlang._qid_db_pool.clear()
        _interlang._qid_db_pool.update(self._saved_pool)
        if _interlang._qid_cache_conn is not None:
            try:
                _interlang._qid_cache_conn.close()
            except Exception:
                pass
        _interlang._qid_cache_conn = self._saved_cache_conn
        _srv._zim_list_cache = self._saved_zim_list
        self._patch_dir.stop()


class ResolveAlmanacQidsTests(_QidFixtureMixin, unittest.TestCase):
    def setUp(self):
        self._setup_qids()
        # One English wikipedia ZIM with a built Q-ID index.
        _make_qid_index(
            self.tmp,
            "wikipedia_en_test",
            {"A/Mercury_(planet)": 308, "A/Earth": 2, "A/Sun": 525},
        )
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en", "entry_count": 5000},
        ]

    def tearDown(self):
        self._teardown_qids()

    def test_hits_resolve_with_title_and_path(self):
        out = _srv.resolve_almanac_qids(["Q308", "Q2"], ["en"])
        self.assertEqual(out["Q308"]["zim"], "wikipedia_en_test")
        self.assertEqual(out["Q308"]["path"], "A/Mercury_(planet)")
        # Title derived lexically from the path (no libzim).
        self.assertEqual(out["Q308"]["title"], "Mercury (planet)")
        self.assertEqual(out["Q2"]["path"], "A/Earth")

    def test_miss_is_absent_not_fallback(self):
        # Q-ID not in any index -> simply absent (never a title-search fallback).
        out = _srv.resolve_almanac_qids(["Q308", "Q999999"], ["en"])
        self.assertIn("Q308", out)
        self.assertNotIn("Q999999", out)

    def test_malformed_qids_skipped(self):
        out = _srv.resolve_almanac_qids(
            ["notaqid", "Q", "123", "Q12x", "", "Q308"], ["en"]
        )
        self.assertEqual(list(out.keys()), ["Q308"])

    def test_duplicate_qids_resolved_once(self):
        out = _srv.resolve_almanac_qids(["Q2", "Q2", "Q2"], ["en"])
        self.assertEqual(list(out.keys()), ["Q2"])

    def test_no_encyclopedia_installed_returns_empty(self):
        _srv._zim_list_cache = [
            {"name": "stackoverflow.com_en_all", "language": "en", "entry_count": 100},
        ]
        out = _srv.resolve_almanac_qids(["Q308", "Q2"], ["en"])
        self.assertEqual(out, {})

    def test_empty_input_returns_empty(self):
        self.assertEqual(_srv.resolve_almanac_qids([], ["en"]), {})
        self.assertEqual(_srv.resolve_almanac_qids(None, ["en"]), {})


class LanguagePreferenceTests(_QidFixtureMixin, unittest.TestCase):
    def setUp(self):
        self._setup_qids()
        # Same Q-ID (Q2 = Earth) present in both an English and a French ZIM.
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Earth": 2})
        _make_qid_index(self.tmp, "wikipedia_fr_test", {"A/Terre": 2})
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en", "entry_count": 5000},
            {"name": "wikipedia_fr_test", "language": "fr", "entry_count": 3000},
        ]

    def tearDown(self):
        self._teardown_qids()

    def test_preferred_language_wins(self):
        out = _srv.resolve_almanac_qids(["Q2"], ["fr", "en"])
        self.assertEqual(out["Q2"]["zim"], "wikipedia_fr_test")
        self.assertEqual(out["Q2"]["path"], "A/Terre")

    def test_english_default_when_no_pref(self):
        # No langs given -> English preferred by default.
        out = _srv.resolve_almanac_qids(["Q2"], None)
        self.assertEqual(out["Q2"]["zim"], "wikipedia_en_test")

    def test_unavailable_pref_falls_through_to_english(self):
        # Prefer German (not installed) -> falls through to English.
        out = _srv.resolve_almanac_qids(["Q2"], ["de"])
        self.assertEqual(out["Q2"]["zim"], "wikipedia_en_test")


class AlmanacLinksEndpointTests(_QidFixtureMixin, unittest.TestCase):
    def setUp(self):
        self._setup_qids()
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Earth": 2})
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en", "entry_count": 5000},
        ]

    def tearDown(self):
        self._teardown_qids()

    def test_valid_batch_returns_links(self):
        h = _Handler()
        _http._almanac_links_response(h, ["Q2", "Q999999"], ["en"])
        self.assertEqual(h.status, 200)
        self.assertIn("links", h.body)
        self.assertIn("Q2", h.body["links"])
        self.assertNotIn("Q999999", h.body["links"])

    def test_qids_must_be_list(self):
        h = _Handler()
        _http._almanac_links_response(h, "Q2,Q3", ["en"])
        self.assertEqual(h.status, 400)

    def test_langs_must_be_list(self):
        h = _Handler()
        _http._almanac_links_response(h, ["Q2"], "en")
        self.assertEqual(h.status, 400)

    def test_batch_size_capped(self):
        h = _Handler()
        too_many = [f"Q{i}" for i in range(_srv.ALMANAC_QID_BATCH_MAX + 1)]
        _http._almanac_links_response(h, too_many, ["en"])
        self.assertEqual(h.status, 400)

    def test_batch_at_cap_allowed(self):
        h = _Handler()
        at_cap = [f"Q{i}" for i in range(1, _srv.ALMANAC_QID_BATCH_MAX + 1)]
        _http._almanac_links_response(h, at_cap, ["en"])
        self.assertEqual(h.status, 200)

    def test_langs_optional(self):
        h = _Handler()
        _http._almanac_links_response(h, ["Q2"], None)
        self.assertEqual(h.status, 200)
        self.assertIn("Q2", h.body["links"])

    def test_endpoint_is_rate_limited_public_read(self):
        # Rides the API rate-limit bucket like /suggest — no auth involved.
        self.assertIn("/almanac-links", _http._RATE_LIMITED_API_PATHS)


if __name__ == "__main__":
    unittest.main()
