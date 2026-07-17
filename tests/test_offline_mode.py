"""Offline audit: everything the post-world story promises must actually
work with zero internet. urlopen is dead in every test here.

The catalog search question specifically: the web UI fetches the FULL
catalog (paged, no q= param) and filters client-side, so offline search
works as long as the stale full pages serve — which these tests pin.
"""

import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.p2p as p2p  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture(autouse=True)
def _dead_network(monkeypatch):
    def _boom(*a, **k):
        raise OSError("network is gone")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)


@pytest.fixture
def _env(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)
    lib._catalog_stale_ts = None
    return zim_dir


def test_full_catalog_page_serves_stale_offline(_env):
    """The exact request the UI makes (q='', full page) survives offline —
    which is what makes client-side catalog search work with no internet."""
    key = "|eng|500|0"
    items = [
        {"name": "wikipedia_en_all", "title": "Wikipedia"},
        {"name": "wikivoyage_en_all", "title": "Wikivoyage"},
    ]
    lib._opds_cache[key] = (50.0, 2, items)  # long expired
    total, got, err = lib._fetch_kiwix_catalog("", "eng", 500, 0)
    assert err is None and got == items
    assert lib._catalog_stale_ts == 50.0
    del lib._opds_cache[key]
    lib._catalog_stale_ts = None


def test_mirror_seeds_from_saved_torrents_offline(_env, monkeypatch):
    """Mirror mode must bootstrap from the local torrent archive when the
    catalog and torrent URLs are unreachable."""
    (_env / "foo_2026-06.zim").write_bytes(b"x")
    tfile = _env.parent / "data" / "saved.torrent"
    tfile.parent.mkdir(exist_ok=True)
    tfile.write_bytes(b"d4:infod4:name3:fooee")

    class _B:
        added = []

        def list_managed(self):
            return []

        def add_torrent(self, source, *, dest_dir, options=None):
            self.added.append(source)
            return "gid-1"

    backend = _B()
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: True)
    monkeypatch.setattr(p2p, "should_pause_for_disk_pressure", lambda d: False)
    monkeypatch.setattr(p2p, "get_backend", lambda **kw: backend)
    monkeypatch.setattr(
        lib,
        "_get_torrent_metadata",
        lambda: {"foo_2026-06.zim": {"torrent_file": str(tfile)}},
    )
    assert lib.mirror_sync() == 1
    assert backend.added == [str(tfile)]


def test_magnets_extracted_from_archived_torrents_offline(_env, monkeypatch):
    """No network needed when the .torrent is already archived locally."""
    lib._magnets_ensured = False
    (_env / "bar_2026-06.zim").write_bytes(b"x")
    tdir = _env.parent / "data" / "bt" / "torrents"
    tdir.mkdir(parents=True)
    (tdir / "bar_2026-06.zim.torrent").write_bytes(b"d4:infod4:name3:baree")
    # Catalog lookup returns nothing offline, but archived file wins first
    assert lib.ensure_magnets_for_installed(spacing=0) == 1
    meta = lib._get_torrent_metadata()
    assert meta["bar_2026-06.zim"]["magnet"].startswith("magnet:?xt=urn:btih:")
    lib._magnets_ensured = False


def test_catalog_torrent_archive_retries_next_run_when_offline(_env, monkeypatch):
    lib._catalog_torrents_archived = False
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: True)
    # No cache at all: fetch fails offline -> archive defers, not marked done
    assert lib.archive_catalog_torrents(spacing=0) == 0
    assert lib._catalog_torrents_archived is False


def test_thumb_fetch_fails_soft_offline(_env):
    data, ct = lib._fetch_thumb("https://library.kiwix.org/x.png")
    assert data is None and ct is None
