"""Stale-while-revalidate for the Kiwix catalog.

The field-report bug: the catalog was slow to load because a stale server-side
cache still blocked on a NAS→Kiwix OPDS round trip before answering. These
tests pin the fix — a stale copy is served instantly and revalidated in one
background thread — while proving the cold and fresh paths are untouched.
"""

import os
import sys
import threading
import time
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402

# Minimal valid OPDS (Atom) feed the parser accepts: one entry, one result.
_FRESH_XML = (
    b'<feed xmlns="http://www.w3.org/2005/Atom"'
    b' xmlns:dc="http://purl.org/dc/terms/">'
    b"<totalResults>1</totalResults>"
    b"<entry><name>fresh_zim</name><title>Fresh</title></entry>"
    b"</feed>"
)


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def _env(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)  # isolate from disk
    monkeypatch.setattr(lib, "_thumb_prefetch_started", True)  # no thumb threads
    # Earlier dead-network tests (test_offline_mode et al.) leave the fail
    # cooldown armed, which silently suppresses _kick_catalog_refresh here.
    monkeypatch.setattr(lib, "_opds_last_fail", 0.0)
    lib._opds_cache.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None
    yield zim_dir
    lib._opds_cache.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None


def test_stale_returns_immediately_and_spawns_single_refresh(_env, monkeypatch):
    """A stale page is served instantly, marked stale, and revalidated by
    exactly one background thread even under concurrent requests."""
    key = "|eng|500|0"
    stale_items = [{"name": "old_zim", "title": "Old"}]
    lib._opds_cache[key] = (100.0, 1, stale_items)  # far past the 24h TTL

    calls = []
    release = threading.Event()

    def fake_urlopen(req, *a, **k):
        calls.append(1)
        release.wait(5)  # hold the network open so we can prove we didn't wait
        return _FakeResp(_FRESH_XML)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    # Served instantly from the stale cache — the blocked network never delays us.
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0)
    assert err is None
    assert items == stale_items
    assert lib._catalog_stale_ts == 100.0
    # A single background refresh is registered (added synchronously on kick).
    assert key in lib._opds_refreshing

    # A concurrent request for the same page dedups onto the in-flight refresh.
    _t2, i2, e2 = lib._fetch_kiwix_catalog("", "eng", 500, 0)
    assert e2 is None and i2 == stale_items

    # Let the background refresh complete and replace the cache.
    release.set()
    for _ in range(200):
        if lib._opds_cache[key][0] != 100.0:
            break
        time.sleep(0.02)
    assert lib._opds_cache[key][0] != 100.0  # refreshed to a current timestamp
    assert lib._opds_cache[key][2][0]["name"] == "fresh_zim"
    assert calls == [1]  # exactly one Kiwix fetch despite two requests
    assert key not in lib._opds_refreshing  # in-flight marker cleaned up


def test_cold_cache_fetches_synchronously(_env, monkeypatch):
    """No cached copy at all keeps the original blocking behavior — fetch
    in-band, mark fresh, spawn no background thread."""
    calls = []

    def fake_urlopen(req, *a, **k):
        calls.append(1)
        return _FakeResp(_FRESH_XML)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    total, items, err = lib._fetch_kiwix_catalog("coldq", "eng", 5, 0)
    assert err is None
    assert items and items[0]["name"] == "fresh_zim"
    assert calls == [1]  # fetched synchronously, in-band
    assert lib._catalog_stale_ts is None  # fresh, not stale
    assert "coldq|eng|5|0" not in lib._opds_refreshing  # no background refresh


def test_fresh_cache_returns_without_network(_env, monkeypatch):
    """A within-TTL cache answers from memory: no network, no refresh."""
    key = "freshq|eng|5|0"
    fresh_items = [{"name": "cached_zim", "title": "Cached"}]
    lib._opds_cache[key] = (time.time(), 1, fresh_items)

    calls = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: calls.append(1))

    total, items, err = lib._fetch_kiwix_catalog("freshq", "eng", 5, 0)
    assert err is None
    assert items == fresh_items
    assert lib._catalog_stale_ts is None
    assert calls == []  # never touched the network
    assert key not in lib._opds_refreshing
