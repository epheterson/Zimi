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


def test_seed_options_uses_mirror_ratio_when_enabled(monkeypatch):
    monkeypatch.setenv("ZIMI_MIRROR", "1")
    monkeypatch.setenv("ZIMI_MIRROR_RATIO", "100")
    opts = p2p.effective_seed_options()
    # Mirror lifts the ratio cap. Speed is NOT capped per-torrent anymore —
    # the global up/down limits govern bandwidth — so max-upload-limit is
    # "0K" (unlimited per-torrent).
    assert float(opts["seed-ratio"]) == 100.0
    assert opts["max-upload-limit"] == "0K"


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


# ────────────────────────────────────────────────────────────────────────────
# True mirror mode: seed the installed library; retire seeds updates orphaned
# ────────────────────────────────────────────────────────────────────────────


class _FakeBackend:
    def __init__(self, managed=None, options=None):
        self.managed = managed or []
        self.options = options or {}  # {gid: {"seed-ratio": ...}}
        self.added = []
        self.removed = []

    def list_managed(self):
        return self.managed

    def add_torrent(self, source, *, dest_dir, options=None):
        self.added.append((source, dest_dir, options or {}))
        return "gid-" + str(len(self.added))

    def remove(self, tid, *, delete_files=False):
        self.removed.append(tid)

    def get_options(self, tid):
        return self.options.get(tid, {})


@pytest.fixture
def _mirror_env(tmp_path, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p
    import zimi.server as server

    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: True)
    monkeypatch.setattr(p2p, "should_pause_for_disk_pressure", lambda d: False)
    return zim_dir


def test_mirror_sync_seeds_installed_from_catalog(_mirror_env, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p

    (_mirror_env / "wikipedia_en_100_2026-06.zim").write_bytes(b"x")
    backend = _FakeBackend()
    monkeypatch.setattr(p2p, "get_backend", lambda **kw: backend)
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda *a, **k: (
            1,
            [
                {
                    "download_url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-06.zim.meta4"
                }
            ],
            None,
        ),
    )
    assert lib.mirror_sync() == 1
    source, dest, opts = backend.added[0]
    assert source.endswith("wikipedia_en_100_2026-06.zim.torrent")
    assert dest == str(_mirror_env)
    assert opts["check-integrity"] == "true"
    assert opts["seed-ratio"] == "0"


def test_mirror_sync_prefers_saved_torrent_file(_mirror_env, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p

    (_mirror_env / "devdocs_en_css_2026-05.zim").write_bytes(b"x")
    tfile = _mirror_env / "saved.torrent"
    tfile.write_bytes(b"d4:infoe")
    backend = _FakeBackend()
    monkeypatch.setattr(p2p, "get_backend", lambda **kw: backend)
    monkeypatch.setattr(
        lib,
        "_get_torrent_metadata",
        lambda: {"devdocs_en_css_2026-05.zim": {"torrent_file": str(tfile)}},
    )
    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", lambda *a, **k: (0, [], None))
    assert lib.mirror_sync() == 1
    assert backend.added[0][0] == str(tfile)


def test_mirror_sync_skips_already_managed(_mirror_env, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p

    (_mirror_env / "a_2026-06.zim").write_bytes(b"x")
    backend = _FakeBackend(
        managed=[{"gid": "g1", "files": [{"path": str(_mirror_env / "a_2026-06.zim")}]}]
    )
    monkeypatch.setattr(p2p, "get_backend", lambda **kw: backend)
    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", lambda *a, **k: (0, [], None))
    assert lib.mirror_sync() == 0
    assert backend.added == []


def test_mirror_sync_off_when_disabled(_mirror_env, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p

    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    assert lib.mirror_sync() == 0


def test_retire_stale_seeds_removes_orphans(_mirror_env, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p

    kept = _mirror_env / "keep_2026-06.zim"
    kept.write_bytes(b"x")
    backend = _FakeBackend(
        managed=[
            {"gid": "g-old", "files": [{"path": str(_mirror_env / "old_2026-01.zim")}]},
            {"gid": "g-keep", "files": [{"path": str(kept)}]},
            {
                "gid": "g-staging",
                "files": [{"path": str(_mirror_env.parent / "staging" / "x.zim")}],
            },
        ]
    )
    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    assert lib.retire_stale_seeds() == 1
    assert backend.removed == ["g-old"]


def test_archive_catalog_torrents_fetches_all(_mirror_env, monkeypatch):
    import io
    import urllib.request as _ur

    import zimi.library as lib

    lib._catalog_torrents_archived = False
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda q, l, c, s: (
            2,
            [
                {
                    "download_url": "https://download.kiwix.org/zim/a/a_2026-06.zim.meta4"
                },
                {
                    "download_url": "https://download.kiwix.org/zim/b/b_2026-06.zim.meta4"
                },
            ],
            None,
        ),
    )

    class _R(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(_ur, "urlopen", lambda *a, **k: _R(b"d4:infoe"))
    fetched = lib.archive_catalog_torrents(spacing=0)
    assert fetched == 2
    import zimi.server as server

    tdir = os.path.join(server.ZIMI_DATA_DIR, "bt", "torrents")
    assert sorted(os.listdir(tdir)) == [
        "a_2026-06.zim.torrent",
        "b_2026-06.zim.torrent",
    ]
    # Second call in the same run is a no-op
    assert lib.archive_catalog_torrents(spacing=0) == 0
    lib._catalog_torrents_archived = False


def test_archive_rejects_non_bencode(_mirror_env, monkeypatch):
    import io
    import urllib.request as _ur

    import zimi.library as lib

    lib._catalog_torrents_archived = False
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda q, l, c, s: (
            1,
            [{"download_url": "https://download.kiwix.org/zim/x/x_2026-06.zim.meta4"}],
            None,
        ),
    )

    class _R(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(_ur, "urlopen", lambda *a, **k: _R(b"<html>404</html>"))
    assert lib.archive_catalog_torrents(spacing=0) == 0
    lib._catalog_torrents_archived = False


def test_archive_skipped_when_mirror_off(_mirror_env, monkeypatch):
    import zimi.library as lib
    import zimi.p2p as p2p

    lib._catalog_torrents_archived = False
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    assert lib.archive_catalog_torrents(spacing=0) == 0
    assert lib._catalog_torrents_archived is False


# ────────────────────────────────────────────────────────────────────────────
# Magnets for all users; torrent files only for mirrors; mirror-off teardown
# ────────────────────────────────────────────────────────────────────────────


def _mini_torrent():
    """A tiny valid bencoded torrent: d8:announce3:url4:infod4:name3:fooee"""
    return b"d8:announce3:url4:infod4:name3:fooee"


def test_torrent_info_hash_extraction():
    import hashlib

    import zimi.library as lib

    data = _mini_torrent()
    expected = hashlib.sha1(b"d4:name3:fooe").hexdigest()
    assert lib._torrent_info_hash(data) == expected
    assert lib._torrent_info_hash(b"<html>nope</html>") is None
    assert lib._torrent_info_hash(b"d4:spam3:egge") is None  # no info key


def test_ensure_magnets_regular_user_discards_torrent(_mirror_env, monkeypatch):
    import io
    import urllib.request as _ur

    import zimi.library as lib
    import zimi.p2p as p2p
    import zimi.server as server

    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    lib._magnets_ensured = False
    (_mirror_env / "foo_2026-06.zim").write_bytes(b"x")
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda *a, **k: (
            1,
            [
                {
                    "download_url": "https://download.kiwix.org/zim/f/foo_2026-06.zim.meta4"
                }
            ],
            None,
        ),
    )

    class _R(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(_ur, "urlopen", lambda *a, **k: _R(_mini_torrent()))
    assert lib.ensure_magnets_for_installed(spacing=0) == 1
    meta = lib._get_torrent_metadata()
    assert meta["foo_2026-06.zim"]["magnet"].startswith("magnet:?xt=urn:btih:")
    # Regular users keep the magnet, not the file
    tdir = os.path.join(server.ZIMI_DATA_DIR, "bt", "torrents")
    assert not os.path.exists(os.path.join(tdir, "foo_2026-06.zim.torrent"))
    lib._magnets_ensured = False


def test_ensure_magnets_mirror_keeps_torrent_file(_mirror_env, monkeypatch):
    import io
    import urllib.request as _ur

    import zimi.library as lib
    import zimi.server as server

    lib._magnets_ensured = False
    (_mirror_env / "bar_2026-06.zim").write_bytes(b"x")
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda *a, **k: (
            1,
            [
                {
                    "download_url": "https://download.kiwix.org/zim/b/bar_2026-06.zim.meta4"
                }
            ],
            None,
        ),
    )

    class _R(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(_ur, "urlopen", lambda *a, **k: _R(_mini_torrent()))
    assert lib.ensure_magnets_for_installed(spacing=0) == 1
    meta = lib._get_torrent_metadata()
    assert os.path.isfile(meta["bar_2026-06.zim"]["torrent_file"])
    lib._magnets_ensured = False


def test_stop_mirror_seeds_removes_only_mirror_origin_seeds(_mirror_env, monkeypatch):
    """Mirror off must not kill ordinary personal seeds. All seeds run at
    aria2 ratio 0 now (Zimi enforces caps), so mirror-class seeds are told
    apart by their recorded ledger origin, not their aria2 options."""
    import zimi.library as lib
    import zimi.p2p as p2p

    mirror_file = _mirror_env / "mirror_2026-06.zim"
    mirror_file.write_bytes(b"x")
    normal_file = _mirror_env / "normal_2026-06.zim"
    normal_file.write_bytes(b"x")
    lib.record_seed("mirror_2026-06.zim", origin="mirror")
    lib.record_seed("normal_2026-06.zim", origin="download")
    backend = _FakeBackend(
        managed=[
            {"gid": "g-mirror", "files": [{"path": str(mirror_file)}]},
            {"gid": "g-normal", "files": [{"path": str(normal_file)}]},
            {
                "gid": "g-staging",
                "files": [{"path": str(_mirror_env.parent / "staging" / "dl.zim")}],
            },
        ],
        options={
            "g-mirror": {"seed-ratio": "0"},
            "g-normal": {"seed-ratio": "2.0"},
        },
    )
    monkeypatch.setattr(p2p, "peek_backend", lambda: backend)
    assert lib.stop_mirror_seeds() == 1
    assert backend.removed == ["g-mirror"]
    # Files untouched, personal seed untouched — and its intent survives
    # while the mirror seed's intent is gone.
    assert mirror_file.exists() and normal_file.exists()
    assert "normal_2026-06.zim" in lib._seed_ledger()
    assert "mirror_2026-06.zim" not in lib._seed_ledger()
