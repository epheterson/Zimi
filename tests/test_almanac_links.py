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
import re
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
        self._patch_dir = mock.patch.object(_interlang, "_qid_index_dir", lambda: self.tmp)
        self._patch_dir.start()
        # Isolate the pooled connections + on-demand cache for the temp dir.
        self._saved_pool = dict(_interlang._qid_db_pool)
        _interlang._qid_db_pool.clear()
        self._saved_cache_conn = _interlang._qid_cache_conn
        _interlang._qid_cache_conn = None
        self._saved_zim_list = _srv._zim_list_cache
        # Isolate the server-side resolved-batch memo so a prior test's answer
        # can't satisfy this one (the key encodes library generation, not the
        # zim-list contents these tests swap in place).
        self._saved_alm_cache = dict(_interlang._almanac_resolve_cache)
        _interlang._almanac_resolve_cache.clear()

    def _teardown_qids(self):
        _interlang._almanac_resolve_cache.clear()
        _interlang._almanac_resolve_cache.update(self._saved_alm_cache)
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


class _LockSpy:
    """A _zim_lock stand-in that counts context-manager entries but otherwise
    behaves like a real lock — so tests can assert the title fallback actually
    serializes its libzim access."""

    def __init__(self):
        import threading

        self._lock = threading.Lock()
        self.enters = 0

    def __enter__(self):
        self.enters += 1
        return self._lock.__enter__()

    def __exit__(self, *a):
        return self._lock.__exit__(*a)

    def acquire(self, *a, **k):
        return self._lock.acquire(*a, **k)

    def release(self):
        return self._lock.release()


class TitleFallbackTests(_QidFixtureMixin, unittest.TestCase):
    """Exact-title fallback against a REAL wikipedia-shaped ZIM.

    The fixture ZIM carries NO Q-ID index, so the only way these Q-IDs resolve is
    via the curated English title supplied alongside them (direct + redirect).
    """

    def setUp(self):
        import tempfile

        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from conftest_zim import build_wiki_fixture_zim

        self._setup_qids()
        self._zdir = tempfile.mkdtemp(prefix="zimi-alm-wiki-")
        zpath = os.path.join(self._zdir, "wikipedia_en_test.zim")
        build_wiki_fixture_zim(zpath)
        self._archive = _srv.open_archive(zpath)
        # Inject the open archive straight into the pool under the ZIM name the
        # candidate list + get_archive() will look up.
        self._saved_pool = dict(_srv._archive_pool)
        _srv._archive_pool["wikipedia_en_test"] = self._archive
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en", "entry_count": 5000},
        ]

    def tearDown(self):
        _srv._archive_pool.clear()
        _srv._archive_pool.update(self._saved_pool)
        self._teardown_qids()

    def test_title_fallback_direct_hit(self):
        # No index → Q-ID missed → resolved by exact curated title (direct entry).
        out = _srv.resolve_almanac_qids(["Q308"], ["en"], {"Q308": "Mercury (planet)"})
        self.assertIn("Q308", out)
        self.assertEqual(out["Q308"]["zim"], "wikipedia_en_test")
        self.assertEqual(out["Q308"]["path"], "A/Mercury_(planet)")
        self.assertEqual(out["Q308"]["title"], "Mercury (planet)")

    def test_title_fallback_follows_redirect_to_canonical(self):
        # 'Sun' is a redirect to the canonical 'A/Sol' — the resolver must follow
        # the one hop and return the canonical path.
        out = _srv.resolve_almanac_qids(["Q525"], ["en"], {"Q525": "Sun"})
        self.assertIn("Q525", out)
        self.assertEqual(out["Q525"]["path"], "A/Sol")

    def test_title_miss_stays_absent(self):
        # A title with no matching entry is a miss, never a fuzzy/search fallback.
        out = _srv.resolve_almanac_qids(
            ["Q999999"], ["en"], {"Q999999": "Nonexistent Article Title"}
        )
        self.assertNotIn("Q999999", out)

    def test_no_title_provided_is_absent(self):
        # Without a curated title there is nothing to fall back to → absent.
        out = _srv.resolve_almanac_qids(["Q308"], ["en"], None)
        self.assertNotIn("Q308", out)

    def test_non_english_zim_excluded_from_title_fallback(self):
        # Strict-language rule: the curated title is English, so a French-only
        # library must NOT resolve it by title (no wrong-language link).
        _srv._archive_pool["wikipedia_fr_test"] = self._archive  # same content
        _srv._zim_list_cache = [
            {"name": "wikipedia_fr_test", "language": "fr", "entry_count": 5000},
        ]
        out = _srv.resolve_almanac_qids(["Q308"], ["fr"], {"Q308": "Mercury (planet)"})
        self.assertNotIn("Q308", out)

    def test_title_fallback_holds_zim_lock(self):
        # Lock discipline: the fallback touches libzim, so it must acquire
        # _zim_lock (the C library is not thread-safe).
        spy = _LockSpy()
        with mock.patch.object(_srv, "_zim_lock", spy):
            out = _srv.resolve_almanac_qids(
                ["Q308"], ["en"], {"Q308": "Mercury (planet)"}
            )
        self.assertIn("Q308", out)
        self.assertGreaterEqual(spy.enters, 1)

    def test_pure_index_path_does_not_take_zim_lock(self):
        # Contrast: an index hit (no title miss) never enters the libzim fallback,
        # so _zim_lock stays untouched — proving the lock guards only the fallback.
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Mercury_(planet)": 308})
        # Drop the pooled qid-db handle so the new index file is picked up.
        _interlang._qid_db_pool.clear()
        spy = _LockSpy()
        with mock.patch.object(_srv, "_zim_lock", spy):
            out = _srv.resolve_almanac_qids(
                ["Q308"], ["en"], {"Q308": "Mercury (planet)"}
            )
        self.assertEqual(out["Q308"]["path"], "A/Mercury_(planet)")
        self.assertEqual(spy.enters, 0)


class ResolveCacheTests(_QidFixtureMixin, unittest.TestCase):
    """The resolved batch is memoized so a repeat open is one dict hit."""

    def setUp(self):
        self._setup_qids()
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Earth": 2})
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en", "entry_count": 5000},
        ]

    def tearDown(self):
        self._teardown_qids()

    def test_repeat_batch_served_from_cache(self):
        calls = {"n": 0}
        real = _interlang._qid_find_in_zim

        def counting(name, qid_int):
            calls["n"] += 1
            return real(name, qid_int)

        with mock.patch.object(_interlang, "_qid_find_in_zim", counting):
            first = _srv.resolve_almanac_qids(["Q2"], ["en"])
            after_first = calls["n"]
            second = _srv.resolve_almanac_qids(["Q2"], ["en"])
        self.assertEqual(first, second)
        self.assertEqual(first["Q2"]["path"], "A/Earth")
        self.assertGreater(after_first, 0)
        # Second call resolved purely from the memo — no further index probes.
        self.assertEqual(calls["n"], after_first)

    def test_cache_key_includes_library_generation(self):
        _srv.resolve_almanac_qids(["Q2"], ["en"])
        # A library reload bumps _cache_generation → the old memo entry no longer
        # keys, so the batch is recomputed (not a stale hit).
        saved_gen = _srv._cache_generation
        try:
            _srv._cache_generation = saved_gen + 1
            calls = {"n": 0}
            real = _interlang._qid_find_in_zim

            def counting(name, qid_int):
                calls["n"] += 1
                return real(name, qid_int)

            with mock.patch.object(_interlang, "_qid_find_in_zim", counting):
                _srv.resolve_almanac_qids(["Q2"], ["en"])
            self.assertGreater(calls["n"], 0)
        finally:
            _srv._cache_generation = saved_gen

    def test_titles_change_busts_cache(self):
        # Same Q-IDs + langs but a different titles map is a different request
        # (the fallback could resolve differently), so it must not reuse the memo.
        key_a = _interlang._almanac_cache_key(["Q2"], ["en"], {"Q2": "Earth"})
        key_b = _interlang._almanac_cache_key(["Q2"], ["en"], {"Q2": "Terra"})
        self.assertNotEqual(key_a, key_b)


class TitlesValidationTests(_QidFixtureMixin, unittest.TestCase):
    def setUp(self):
        self._setup_qids()
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Earth": 2})
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en", "entry_count": 5000},
        ]

    def tearDown(self):
        self._teardown_qids()

    def test_titles_must_be_object(self):
        h = _Handler()
        _http._almanac_links_response(h, ["Q2"], ["en"], ["not", "a", "dict"])
        self.assertEqual(h.status, 400)

    def test_titles_optional(self):
        h = _Handler()
        _http._almanac_links_response(h, ["Q2"], ["en"], None)
        self.assertEqual(h.status, 200)
        self.assertIn("Q2", h.body["links"])


class TestClientBatchChunking(unittest.TestCase):
    """The curated set is bigger than one batch, so the client must chunk it.

    Sending it whole once outgrew ALMANAC_QID_BATCH_MAX: the endpoint 400s and
    EVERY almanac entity silently renders as plain text. Pin the client's chunk
    size against the server cap so neither side can drift back into that cliff.
    """

    @staticmethod
    def _js():
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "zimi",
            "static",
            "almanac-links.js",
        )
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def test_chunk_size_within_server_cap(self):
        m = re.search(r"_QID_BATCH_SIZE\s*=\s*(\d+)", self._js())
        self.assertIsNotNone(m, "client chunk size constant missing")
        self.assertLessEqual(int(m.group(1)), _srv.ALMANAC_QID_BATCH_MAX)

    def test_curated_set_exceeds_a_single_batch(self):
        # Documents why chunking exists: the set no longer fits in one request.
        qids = set(re.findall(r"q:\s*'(Q\d+)'", self._js()))
        self.assertGreater(len(qids), _srv.ALMANAC_QID_BATCH_MAX)


if __name__ == "__main__":
    unittest.main()
