"""Boot must make ZERO network requests — the magnet manifest included.

Regression suite for the 1.8.2 politeness contract: ensure_magnets_for_installed
used to fetch the Kiwix OPDS catalog seconds after every default boot (its only
gates were torrent-enabled — default True — and "some installed ZIM lacks an
infohash" — always true for a library not downloaded through Zimi). The fix
makes magnet resolution opportunistic instead of boot-time:

* boot pass: archived .torrent files only, zero network, re-arms itself;
* piggyback: a catalog page fetched over the network for a real reason kicks
  a background resolution pass (network allowed, catalog never re-fetched);
* maintenance: the 12h pass latches _magnet_network_ok, letting resolution
  answer from a STALE cached catalog page with no catalog request at all.
"""

import glob
import io
import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.p2p as p2p  # noqa: E402
import zimi.server as server  # noqa: E402

_BROWSE_KEY = "|eng|500|0"


def _mini_torrent():
    """A tiny valid bencoded torrent: d8:announce3:url4:infod4:name3:fooee"""
    return b"d8:announce3:url4:infod4:name3:fooee"


class _TorrentResp(io.BytesIO):
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
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: True)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)  # isolate from disk
    monkeypatch.setattr(lib, "_thumb_prefetch_started", True)  # no thumb threads
    monkeypatch.setattr(lib, "_magnets_ensured", False)
    monkeypatch.setattr(lib, "_magnet_network_ok", False)  # pre-maintenance state
    monkeypatch.setattr(lib, "_opds_last_fail", 0.0)
    lib._opds_cache.clear()
    yield zim_dir
    lib._opds_cache.clear()
    lib._catalog_stale_ts = None


def _seed_stale_catalog(monkeypatch, filename):
    """A long-expired cached browse page mapping `filename` — the on-disk
    catalog copy a previously-used instance would hold."""
    monkeypatch.setitem(
        lib._opds_cache,
        _BROWSE_KEY,
        (
            100.0,  # 1970 — far past any TTL
            1,
            [{"download_url": "https://download.kiwix.org/zim/x/%s.meta4" % filename}],
        ),
    )


def _deny_network(monkeypatch):
    calls = []

    def _boom(*a, **k):
        calls.append(a)
        raise AssertionError("network request during a forbidden phase: %r" % (a,))

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    return calls


def test_boot_pass_makes_zero_network_requests(_env, monkeypatch):
    """Fresh default instance (no catalog cache anywhere, one installed ZIM
    not downloaded through Zimi): the boot call must touch neither
    library.kiwix.org (catalog) nor download.kiwix.org (.torrent)."""
    (_env / "wikipedia_en_100_2026-06.zim").write_bytes(b"x")
    net_calls = _deny_network(monkeypatch)

    def _no_fetch(*a, **k):
        raise AssertionError("_fetch_kiwix_catalog called from the boot magnet pass")

    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", _no_fetch)

    assert lib.ensure_magnets_for_installed(spacing=0) == 0
    assert net_calls == []
    # Re-armed: the piggyback / maintenance triggers must be able to retry
    assert lib._magnets_ensured is False


def test_boot_pass_offline_even_with_stale_catalog_on_disk(_env, monkeypatch):
    """A stale cached catalog page can name the .torrent URL, but the boot
    window still may not download it — that belongs to maintenance."""
    (_env / "foo_2026-06.zim").write_bytes(b"x")
    _seed_stale_catalog(monkeypatch, "foo_2026-06.zim")
    net_calls = _deny_network(monkeypatch)

    assert lib.ensure_magnets_for_installed(spacing=0) == 0
    assert net_calls == []
    assert lib._magnets_ensured is False


def test_boot_pass_still_harvests_archived_torrents(_env, monkeypatch):
    """Seeding of already-known torrents keeps working at boot: an archived
    .torrent resolves fully offline, even while the network is forbidden."""
    (_env / "bar_2026-06.zim").write_bytes(b"x")
    tdir = _env.parent / "data" / "bt" / "torrents"
    tdir.mkdir(parents=True)
    (tdir / "bar_2026-06.zim.torrent").write_bytes(_mini_torrent())
    _deny_network(monkeypatch)

    assert lib.ensure_magnets_for_installed(spacing=0) == 1
    meta = lib._get_torrent_metadata()
    assert meta["bar_2026-06.zim"]["magnet"].startswith("magnet:?xt=urn:btih:")
    # Nothing left pending — the once-per-run guard stays latched
    assert lib._magnets_ensured is True


def test_magnets_resolve_on_piggyback_path(_env, monkeypatch):
    """network_ok=True (what _kick_magnet_resolution passes): the .torrent
    downloads, the magnet lands in the manifest, and the catalog itself is
    never re-fetched — the cached page is the only URL source."""
    (_env / "foo_2026-06.zim").write_bytes(b"x")
    _seed_stale_catalog(monkeypatch, "foo_2026-06.zim")

    def _no_fetch(*a, **k):
        raise AssertionError("magnet resolution must not fetch the catalog")

    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", _no_fetch)
    fetched_urls = []

    def _fake_urlopen(req, *a, **k):
        fetched_urls.append(req.full_url)
        return _TorrentResp(_mini_torrent())

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    assert lib.ensure_magnets_for_installed(spacing=0, network_ok=True) == 1
    assert fetched_urls == ["https://download.kiwix.org/zim/x/foo_2026-06.zim.torrent"]
    meta = lib._get_torrent_metadata()
    assert meta["foo_2026-06.zim"]["magnet"].startswith("magnet:?xt=urn:btih:")


def test_kick_spawns_thread_and_resolves(_env, monkeypatch):
    """End-to-end piggyback: the kick's cheap guards pass, the background
    thread resolves the magnet with network allowed."""
    (_env / "foo_2026-06.zim").write_bytes(b"x")
    _seed_stale_catalog(monkeypatch, "foo_2026-06.zim")
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda *a, **k: _TorrentResp(_mini_torrent())
    )

    t = lib._kick_magnet_resolution()
    assert t is not None
    t.join(5)
    assert not t.is_alive()
    meta = lib._get_torrent_metadata()
    assert meta["foo_2026-06.zim"]["magnet"].startswith("magnet:?xt=urn:btih:")


def test_kick_declines_when_nothing_missing(_env, monkeypatch):
    """No installed ZIM lacks an infohash -> no thread, no work. Keeps the
    common case (and every ZIM-less test fixture) thread-free."""
    _deny_network(monkeypatch)
    assert lib._kick_magnet_resolution() is None  # empty library
    (_env / "foo_2026-06.zim").write_bytes(b"x")
    monkeypatch.setattr(
        lib,
        "_get_torrent_metadata",
        lambda: {"foo_2026-06.zim": {"info_hash": "ab" * 20}},
    )
    assert lib._kick_magnet_resolution() is None  # all resolved already


def test_catalog_network_fetch_triggers_piggyback(_env, monkeypatch):
    """A real (200) catalog fetch is the piggyback moment; a stale-serve
    that never touches the network is not."""
    xml = (
        b'<feed xmlns="http://www.w3.org/2005/Atom"'
        b' xmlns:dc="http://purl.org/dc/terms/">'
        b"<totalResults>1</totalResults>"
        b"<entry><name>fresh_zim</name><title>Fresh</title></entry>"
        b"</feed>"
    )

    class _FeedResp:
        def read(self):
            return xml

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    kicks = []
    monkeypatch.setattr(lib, "_kick_magnet_resolution", lambda: kicks.append(1))
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _FeedResp())

    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0)
    assert err is None and total == 1
    assert kicks == [1]

    # Stale serve (synchronous, no revalidation thread): no network contact,
    # so no follow-on magnet traffic is earned.
    monkeypatch.setattr(lib, "_OPDS_BG_REFRESH", False)
    monkeypatch.setitem(lib._opds_cache, _BROWSE_KEY, (100.0, 1, items))
    _deny_network(monkeypatch)
    kicks.clear()
    total, items, err = lib._fetch_kiwix_catalog("", "eng", 500, 0)
    assert err is None
    assert kicks == []


def test_maintenance_latch_allows_stale_catalog_resolution(_env, monkeypatch):
    """Condition (c): an idle instance whose catalog refresh is skipped still
    resolves magnets at maintenance time from the stale on-disk page —
    zero catalog requests, only the finite .torrent downloads."""
    (_env / "foo_2026-06.zim").write_bytes(b"x")
    _seed_stale_catalog(monkeypatch, "foo_2026-06.zim")
    monkeypatch.setattr(lib, "_catalog_refresh_wanted", lambda: False)
    catalog_calls = []
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        lambda *a, **k: catalog_calls.append(a) or (0, [], "should not be called"),
    )
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda *a, **k: _TorrentResp(_mini_torrent())
    )

    assert lib.maintenance_catalog_refresh() is False  # idle: no fetch
    assert catalog_calls == []
    assert lib._magnet_network_ok is True  # but the latch is set

    # The maintenance ensure call (same bare signature as boot) now runs
    # with network allowed via the latch, exactly like server.py does.
    assert lib.ensure_magnets_for_installed(spacing=0) == 1
    assert catalog_calls == []  # still zero catalog requests
    meta = lib._get_torrent_metadata()
    assert meta["foo_2026-06.zim"]["magnet"].startswith("magnet:?xt=urn:btih:")
