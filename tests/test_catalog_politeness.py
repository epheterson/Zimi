"""Kiwix ecosystem politeness: the catalog fetch path must identify itself,
request compressed bodies, revalidate with conditional GETs (a 304 keeps the
cached copy and refreshes its TTL), back off after failures, and skip the
standing maintenance refresh entirely on instances that never consume the
catalog. Pins the fleet-scale contract: an idle Zimi makes zero kiwix.org
requests.
"""

import gzip
import io
import os
import sys
import time
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402

_FEED_XML = (
    b'<feed xmlns="http://www.w3.org/2005/Atom"'
    b' xmlns:dc="http://purl.org/dc/terms/">'
    b"<totalResults>1</totalResults>"
    b"<entry><name>polite_zim</name><title>Polite</title></entry>"
    b"</feed>"
)


class _Headers:
    def __init__(self, d=None):
        self._d = d or {}

    def get(self, key, default=None):
        return self._d.get(key, default)


class _FakeResp:
    def __init__(self, data, headers=None):
        self._data = data
        self.headers = _Headers(headers)

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
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)
    monkeypatch.setattr(lib, "_thumb_prefetch_started", True)
    monkeypatch.setattr(lib, "_opds_last_fail", 0.0)
    monkeypatch.setattr(lib, "_catalog_last_used", 0.0)
    lib._opds_cache.clear()
    lib._opds_validators.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None
    yield zim_dir
    lib._opds_cache.clear()
    lib._opds_validators.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None


def test_user_agent_identifies_zimi():
    assert server.ZIMI_VERSION in lib.USER_AGENT
    assert "github.com" in lib.USER_AGENT


def test_fetch_sends_ua_gzip_and_conditional_headers(_env, monkeypatch):
    key = "|eng|500|0"
    lib._opds_cache[key] = (100.0, 1, [{"name": "old"}])  # stale body on hand
    lib._opds_validators[key] = {
        "etag": 'W/"abc123"',
        "last_modified": "Mon, 01 Jan 2026 00:00:00 GMT",
    }
    seen = {}

    def fake_urlopen(req, *a, **k):
        seen.update(dict(req.header_items()))
        return _FakeResp(_FEED_XML)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    # _background=True forces the network path even though a stale copy exists.
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0, _background=True)
    assert err is None and items[0]["name"] == "polite_zim"
    hdrs = {k.lower(): v for k, v in seen.items()}
    assert hdrs.get("user-agent") == lib.USER_AGENT
    assert hdrs.get("accept-encoding") == "gzip"
    assert hdrs.get("if-none-match") == 'W/"abc123"'
    assert hdrs.get("if-modified-since") == "Mon, 01 Jan 2026 00:00:00 GMT"


def test_no_conditional_headers_without_cached_body(_env, monkeypatch):
    """Never send validators when there is no body to fall back on: a 304
    answer would leave us with nothing to serve."""
    lib._opds_validators["coldkey|eng|5|0"] = {"etag": '"zzz"'}
    seen = {}

    def fake_urlopen(req, *a, **k):
        seen.update(dict(req.header_items()))
        return _FakeResp(_FEED_XML)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    lib._fetch_kiwix_catalog("coldkey", "eng", 5, 0)
    hdrs = {k.lower() for k in seen}
    assert "if-none-match" not in hdrs
    assert "if-modified-since" not in hdrs


def test_304_keeps_cached_copy_and_refreshes_ttl(_env, monkeypatch):
    key = "|eng|500|0"
    stale_items = [{"name": "still_good"}]
    lib._opds_cache[key] = (100.0, 1, stale_items)
    lib._opds_validators[key] = {"etag": '"e1"'}

    def fake_urlopen(req, *a, **k):
        raise urllib.error.HTTPError(
            req.full_url, 304, "Not Modified", _Headers(), io.BytesIO(b"")
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0, _background=True)
    assert err is None
    assert items == stale_items
    assert lib._opds_cache[key][0] > 100.0  # TTL refreshed
    assert lib._catalog_stale_ts is None  # counts as fresh, not stale


def test_gzip_response_is_decompressed(_env, monkeypatch):
    def fake_urlopen(req, *a, **k):
        return _FakeResp(gzip.compress(_FEED_XML), headers={"Content-Encoding": "gzip"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    total, items, err = lib._fetch_kiwix_catalog("gz", "eng", 5, 0)
    assert err is None
    assert items and items[0]["name"] == "polite_zim"


def test_etag_recorded_from_response(_env, monkeypatch):
    def fake_urlopen(req, *a, **k):
        return _FakeResp(
            _FEED_XML,
            headers={
                "ETag": '"fresh-tag"',
                "Cache-Control": "max-age=0, must-revalidate",
            },
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    lib._fetch_kiwix_catalog("tagme", "eng", 5, 0)
    val = lib._opds_validators.get("tagme|eng|5|0")
    assert val and val["etag"] == '"fresh-tag"'
    assert "ttl" not in val  # max-age=0 never extends our TTL


def test_server_max_age_longer_than_ttl_is_honored(_env, monkeypatch):
    long_age = lib._OPDS_CACHE_TTL * 3

    def fake_urlopen(req, *a, **k):
        return _FakeResp(_FEED_XML, headers={"Cache-Control": f"max-age={long_age}"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    lib._fetch_kiwix_catalog("longttl", "eng", 5, 0)
    key = "longttl|eng|5|0"
    assert lib._opds_validators[key]["ttl"] == long_age
    # Age the entry past the default TTL but inside the server-granted one:
    # it must still serve from cache with no network call.
    ts, total, items = lib._opds_cache[key]
    lib._opds_cache[key] = (ts - lib._OPDS_CACHE_TTL - 60, total, items)
    calls = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: calls.append(1))
    _t, got, err = lib._fetch_kiwix_catalog("longttl", "eng", 5, 0)
    assert err is None and got == items
    assert calls == []
    assert key not in lib._opds_refreshing


def test_failure_sets_cooldown_and_suppresses_background_kicks(_env, monkeypatch):
    key = "|eng|500|0"
    lib._opds_cache[key] = (100.0, 1, [{"name": "old"}])

    def fake_urlopen(req, *a, **k):
        raise OSError("network down")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0, _background=True)
    assert err is None  # stale copy served
    assert lib._opds_last_fail > 0
    # Within the cooldown, stale serves must not re-kick background refreshes.
    lib._kick_catalog_refresh("", "eng", 500, 0)
    assert key not in lib._opds_refreshing


def test_maintenance_refresh_skipped_on_idle_instance(_env, monkeypatch):
    from zimi import p2p

    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: False)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(server, "_auto_update_enabled", False)
    calls = []
    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", lambda *a, **k: calls.append(1))

    assert lib.maintenance_catalog_refresh() is False
    assert calls == []  # zero kiwix.org requests from an idle instance


@pytest.mark.parametrize("reason", ["mirror", "auto_update", "recent_use"])
def test_maintenance_refresh_runs_when_needed(_env, monkeypatch, reason):
    from zimi import p2p

    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: reason == "mirror")
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: reason == "mirror")
    monkeypatch.setattr(server, "_auto_update_enabled", reason == "auto_update")
    if reason == "recent_use":
        monkeypatch.setattr(lib, "_catalog_last_used", time.time() - 3600)
    calls = []
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda *a, **k: calls.append((a, k)) or (0, [], None),
    )

    assert lib.maintenance_catalog_refresh() is True
    assert len(calls) == 1
    assert calls[0][1].get("_internal") is True


def test_user_fetch_marks_catalog_used_but_internal_does_not(_env, monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _FakeResp(_FEED_XML))
    lib._fetch_kiwix_catalog("machinery", "eng", 5, 0, _internal=True)
    assert lib._catalog_last_used == 0.0
    lib._fetch_kiwix_catalog("human", "eng", 5, 0)
    assert lib._catalog_last_used > 0.0
