#!/usr/bin/env python3
"""Deleting a ZIM must not rescan the library under _zim_lock.

POST /manage/delete used to finish with ``load_cache(force=True)`` while
holding ``_zim_lock`` — a full re-open and re-scan of EVERY archive in the
library, behind the one lock every libzim read needs. On a small box serving a
big library off network storage, pressing Delete froze search, reading and
suggest for the length of the rescan, which the browser reads as a crash. It
was the last full-rescan-under-lock left on a user-facing button (#51).

These tests pin the replacement: ``unregister_zim_file`` splices the file out
of the live registry — one directory listing off the lock, dict surgery under
it, no archive opened at all — with the full rescan kept as the fallback.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.interlang as interlang  # noqa: E402
import zimi.server as server  # noqa: E402

from conftest_zim import build_fixture_zim  # noqa: E402

ALPHA = "alpha_en_2026-01.zim"
BETA = "beta_en_2026-01.zim"


def _setup_library(tmp_path, monkeypatch):
    """A real ZIM_DIR with two small ZIMs already scanned into the live caches."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / ALPHA))
    build_fixture_zim(str(zdir / BETA))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    server._zim_files_cache = None
    server._zim_list_cache = None
    server.load_cache(force=True)
    return zdir


def _no_rescan(force=False):
    raise AssertionError("removing a ZIM must not rescan the library")


def _short(filename):
    return server._zim_short_name(filename)


# ---------------------------------------------------------------------------
# The splice itself
# ---------------------------------------------------------------------------


def test_unregister_drops_the_zim_without_a_rescan(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    alpha, beta = _short(ALPHA), _short(BETA)
    assert alpha in server._zim_files_cache
    gen_before = server._cache_generation

    os.remove(str(zdir / ALPHA))
    monkeypatch.setattr(server, "load_cache", _no_rescan)
    # A removal needs no metadata, so nothing may be opened or extracted.
    monkeypatch.setattr(
        server,
        "_extract_zim_metadata",
        lambda *a, **k: pytest.fail("a removal must not open an archive"),
    )

    assert server.unregister_zim_file(ALPHA) is True

    assert alpha not in server._zim_files_cache
    assert not [z for z in server._zim_list_cache if z["name"] == alpha]
    # The rest of the library is untouched — the splice replaces nothing else.
    assert beta in server._zim_files_cache
    assert [z for z in server._zim_list_cache if z["name"] == beta]
    # ETag / interlang invalidation still fires.
    assert server._cache_generation == gen_before + 1


def test_unregister_drops_the_disk_cache_row(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    assert ALPHA in (server._load_disk_cache() or {})

    os.remove(str(zdir / ALPHA))
    monkeypatch.setattr(server, "load_cache", _no_rescan)
    assert server.unregister_zim_file(ALPHA) is True

    disk = server._load_disk_cache() or {}
    assert ALPHA not in disk
    assert BETA in disk  # the surviving ZIM keeps its cached metadata


def test_unregister_evicts_every_pooled_handle(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    alpha, beta = _short(ALPHA), _short(BETA)
    for pool in (server._archive_pool, server._suggest_pool, server._fts_pool):
        pool[alpha] = object()
        pool[beta] = object()
    for locks in (server._suggest_zim_locks, server._fts_zim_locks):
        locks[alpha] = threading.Lock()
        locks[beta] = threading.Lock()

    os.remove(str(zdir / ALPHA))
    monkeypatch.setattr(server, "load_cache", _no_rescan)
    assert server.unregister_zim_file(ALPHA) is True

    for pool in (server._archive_pool, server._suggest_pool, server._fts_pool):
        assert alpha not in pool
        assert beta in pool
    for locks in (server._suggest_zim_locks, server._fts_zim_locks):
        assert alpha not in locks
        assert beta in locks


def test_unregister_drops_the_domain_claims(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    alpha, beta = _short(ALPHA), _short(BETA)
    monkeypatch.setattr(
        interlang, "_domain_zim_map", {"alpha.example": alpha, "beta.example": beta}
    )

    os.remove(str(zdir / ALPHA))
    monkeypatch.setattr(server, "load_cache", _no_rescan)
    assert server.unregister_zim_file(ALPHA) is True

    assert "alpha.example" not in interlang._domain_zim_map
    assert interlang._domain_zim_map["beta.example"] == beta
    # server.py's re-export binding is kept in step with interlang's.
    assert server._domain_zim_map == interlang._domain_zim_map


def test_unregister_of_a_shadowed_duplicate_leaves_the_library_alone(
    tmp_path, monkeypatch
):
    """A same-name copy in a subfolder never held the slot — dropping it is a
    no-op for the registry, and must not evict the root file that did."""
    zdir = _setup_library(tmp_path, monkeypatch)
    sub = zdir / "backups"
    sub.mkdir()
    shutil.copy(str(zdir / ALPHA), str(sub / ALPHA))
    server._zim_files_cache = None
    server._zim_list_cache = None
    server.load_cache()
    alpha = _short(ALPHA)
    files = server._zim_files_cache or {}
    assert files[alpha] == str(zdir / ALPHA)

    os.remove(str(sub / ALPHA))
    monkeypatch.setattr(server, "load_cache", _no_rescan)
    assert server.unregister_zim_file(ALPHA) is True

    files = server._zim_files_cache or {}
    assert files[alpha] == str(zdir / ALPHA)
    assert [z for z in (server._zim_list_cache or []) if z["name"] == alpha]


def test_unregister_defers_when_a_shadowed_copy_would_be_promoted(
    tmp_path, monkeypatch
):
    """Deleting the root file promotes the subfolder copy, and a promotion
    needs metadata only an archive open can supply — that is the caller's
    full-rescan fallback, not a splice."""
    zdir = _setup_library(tmp_path, monkeypatch)
    sub = zdir / "backups"
    sub.mkdir()
    shutil.copy(str(zdir / ALPHA), str(sub / ALPHA))
    os.remove(str(zdir / ALPHA))

    monkeypatch.setattr(server, "load_cache", _no_rescan)
    assert server.unregister_zim_file(ALPHA) is False


def test_unregister_on_an_unscanned_library_just_loads(tmp_path, monkeypatch):
    _setup_library(tmp_path, monkeypatch)
    server._zim_files_cache = None
    server._zim_list_cache = None
    loads = []
    monkeypatch.setattr(server, "load_cache", lambda force=False: loads.append(force))
    assert server.unregister_zim_file(ALPHA) is True
    assert loads == [False]  # a plain load, never a forced rebuild


# ---------------------------------------------------------------------------
# Route wiring: incremental first, one forced rescan only as fallback
# ---------------------------------------------------------------------------


def _start_server(zim_dir):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    os.environ["ZIM_DIR"] = zim_dir
    os.environ["ZIMI_MANAGE"] = "1"
    server.ZIM_DIR = zim_dir
    server.ZIMI_DATA_DIR = os.path.join(zim_dir, ".zimi")
    os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
    server.ZIMI_MANAGE = True
    server._zim_files_cache = None
    server._zim_list_cache = None
    server.load_cache(force=True)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


class TestDeleteRoute(unittest.TestCase):
    """End to end: the Delete button removes the ZIM from the live library."""

    def setUp(self):
        from zimi.manage import _generate_api_token

        self._tmpdir = tempfile.mkdtemp(prefix="zimi-del-")
        build_fixture_zim(os.path.join(self._tmpdir, ALPHA))
        build_fixture_zim(os.path.join(self._tmpdir, BETA))
        self._server, port = _start_server(self._tmpdir)
        self._base = f"http://127.0.0.1:{port}"
        self._token = _generate_api_token()
        self._saved_load = server.load_cache

    def tearDown(self):
        server.load_cache = self._saved_load
        self._server.shutdown()
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _request(self, path, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{self._base}{path}", data=body, method="POST" if body else "GET"
        )
        req.add_header("Authorization", f"Bearer {self._token}")
        if body:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_delete_never_rescans_and_the_zim_disappears(self):
        alpha = _short(ALPHA)
        status, listing = self._request("/list")
        self.assertEqual(status, 200)
        self.assertIn(alpha, [z["name"] for z in listing])

        def no_rescan(force=False):
            raise AssertionError("the delete route must not rescan the library")

        server.load_cache = no_rescan
        status, data = self._request("/manage/delete", {"filename": ALPHA})
        self.assertEqual(status, 200, data)
        self.assertEqual(data.get("status"), "deleted")

        self.assertFalse(os.path.exists(os.path.join(self._tmpdir, ALPHA)))
        status, listing = self._request("/list")
        names = [z["name"] for z in listing]
        self.assertNotIn(alpha, names)
        self.assertIn(_short(BETA), names)
        # Search must not answer out of the deleted ZIM either — and the
        # surviving ZIM still answers, so this isn't passing on an empty list.
        status, results = self._request("/search?q=water&limit=20")
        self.assertEqual(status, 200)
        hit_zims = [r.get("zim") for r in results.get("results", [])]
        self.assertNotIn(alpha, hit_zims)
        self.assertIn(_short(BETA), hit_zims)

    def test_delete_falls_back_to_a_full_rescan_when_the_splice_defers(self):
        rescans = []
        saved = server.unregister_zim_file
        server.unregister_zim_file = lambda filename: False
        server.load_cache = lambda force=False: rescans.append(force)
        try:
            status, data = self._request("/manage/delete", {"filename": ALPHA})
        finally:
            server.unregister_zim_file = saved
        self.assertEqual(status, 200, data)
        self.assertEqual(rescans, [True])

    def test_delete_falls_back_when_the_splice_raises(self):
        rescans = []
        saved = server.unregister_zim_file

        def boom(filename):
            raise RuntimeError("disk went away")

        server.unregister_zim_file = boom
        server.load_cache = lambda force=False: rescans.append(force)
        try:
            status, data = self._request("/manage/delete", {"filename": ALPHA})
        finally:
            server.unregister_zim_file = saved
        self.assertEqual(status, 200, data)
        self.assertEqual(rescans, [True])


if __name__ == "__main__":
    unittest.main()
