"""Tests for the become-a-mirror toggle.

Mirror mode = seeding-everything-with-relaxed-caps. Implementation lives
in zimi.p2p alongside the rest of the BT config helpers; the
/manage/mirror endpoint serializes the same data."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p as p2p  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in (
        "ZIMI_MIRROR",
        "ZIMI_MIRROR_RATIO",
        "ZIMI_MIRROR_UPLOAD_KB",
        "ZIMI_SEED_RATIO",
        "ZIMI_SEED_UPLOAD_KB",
    ):
        monkeypatch.delenv(k, raising=False)
    yield


def test_mirror_disabled_by_default():
    assert p2p.is_mirror_enabled() is False


def test_mirror_enabled_via_env(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR", "1")
    assert p2p.is_mirror_enabled() is True


def test_mirror_disabled_zero(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR", "0")
    assert p2p.is_mirror_enabled() is False


def test_mirror_disabled_off(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR", "off")
    assert p2p.is_mirror_enabled() is False


def test_mirror_default_caps():
    # Mirror mode lifts the ratio cap to "unlimited" (large number) and
    # raises the upload limit. In non-mirror mode they fall back to the
    # default user values.
    assert p2p.get_mirror_ratio_cap() >= 100.0  # effectively uncapped
    assert p2p.get_mirror_upload_kb() >= 5000


def test_mirror_ratio_overridable(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR_RATIO", "50")
    assert p2p.get_mirror_ratio_cap() == 50.0


def test_mirror_upload_overridable(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR_UPLOAD_KB", "20000")
    assert p2p.get_mirror_upload_kb() == 20000


def test_mirror_ratio_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR_RATIO", "garbage")
    assert p2p.get_mirror_ratio_cap() >= 100.0


def test_mirror_status_dict_shape():
    status = p2p.get_mirror_status()
    assert "enabled" in status
    assert "ratio_cap" in status
    assert "upload_kb" in status
    assert isinstance(status["enabled"], bool)
    assert isinstance(status["ratio_cap"], float)
    assert isinstance(status["upload_kb"], int)


def test_mirror_status_reflects_env(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR", "1")
    monkeypatch.setenv("ZIMI_MIRROR_RATIO", "10")
    monkeypatch.setenv("ZIMI_MIRROR_UPLOAD_KB", "8000")
    status = p2p.get_mirror_status()
    assert status["enabled"] is True
    assert status["ratio_cap"] == 10.0
    assert status["upload_kb"] == 8000


def test_seed_options_uses_mirror_caps_when_enabled(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR", "1")
    monkeypatch.setenv("ZIMI_MIRROR_RATIO", "100")
    monkeypatch.setenv("ZIMI_MIRROR_UPLOAD_KB", "10000")
    opts = p2p.effective_seed_options()
    # When mirror's on we use mirror's caps
    assert float(opts["seed-ratio"]) == 100.0
    assert opts["max-upload-limit"] == "10000K"


def test_seed_options_uses_user_caps_when_mirror_off():
    opts = p2p.effective_seed_options()
    # Default ratio cap is 2.0 (DEFAULT_RATIO_CAP)
    assert float(opts["seed-ratio"]) == p2p.DEFAULT_RATIO_CAP


# ────────────────────────────────────────────────────────────────────────────
# Post-world resilience: catalog survives offline, torrent metadata persists
# ────────────────────────────────────────────────────────────────────────────


def test_stale_catalog_served_when_kiwix_unreachable(tmp_path, monkeypatch):
    import urllib.request

    import zimi.library as lib
    import zimi.server as server

    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)  # isolate from disk
    lib._catalog_stale_ts = None
    key = "|eng|500|0"
    stale_items = [{"name": "wikipedia_en_all", "title": "Wikipedia"}]
    # Entry is far past the TTL — normally it would be refetched
    lib._opds_cache[key] = (100.0, 1, stale_items)

    def _boom(*a, **k):
        raise OSError("no internet")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0)
    assert err is None
    assert items == stale_items
    assert lib._catalog_stale_ts == 100.0
    del lib._opds_cache[key]
    lib._catalog_stale_ts = None


def test_catalog_error_without_any_cache(tmp_path, monkeypatch):
    import urllib.request

    import zimi.library as lib
    import zimi.server as server

    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)

    def _boom(*a, **k):
        raise OSError("no internet")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    total, items, err = lib._fetch_kiwix_catalog("never-seen", "eng", 5, 0)
    assert err is not None and items == []


def test_torrent_metadata_roundtrip(tmp_path, monkeypatch):
    import zimi.library as lib
    import zimi.server as server

    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "foo.zim.torrent").write_bytes(b"d4:infoe")
    lib._record_torrent_metadata(
        "foo.zim",
        info_hash="abc123",
        torrent_url="https://download.kiwix.org/zim/foo.zim.torrent",
        staging_dir=str(staging),
    )
    meta = lib._get_torrent_metadata()
    assert meta["foo.zim"]["info_hash"] == "abc123"
    assert meta["foo.zim"]["magnet"] == "magnet:?xt=urn:btih:abc123"
    assert os.path.isfile(meta["foo.zim"]["torrent_file"])
