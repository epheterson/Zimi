"""An HTTP-completed download must still seed when BitTorrent is on.

The BT transport seeds inline on completion; the HTTP path (fresh download
or BT fallback) historically did not, so a ZIM whose .torrent had no live
seeders silently never shared. _seed_after_http_download closes that gap.
"""

import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.p2p as p2p  # noqa: E402


def _wire(
    monkeypatch,
    *,
    seeding=True,
    torrent_on=True,
    mirror=False,
    cap=2.0,
    backend=MagicMock(),
    meta=None,
    resolved="https://k/x.zim.torrent",
    zim_dir="/zim",
):
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: torrent_on)
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: seeding)
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: mirror)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: cap)
    monkeypatch.setattr(p2p, "get_backend", lambda data_dir=None: backend)
    monkeypatch.setattr(lib, "_get_torrent_metadata", lambda: (meta or {}))
    monkeypatch.setattr(lib, "_resolve_torrent_url", lambda url: resolved)
    monkeypatch.setattr(lib._srv, "ZIM_DIR", zim_dir)
    monkeypatch.setattr(lib._srv, "ZIMI_DATA_DIR", "/data")
    return backend


def test_http_download_seeds_with_hash_check(monkeypatch):
    backend = _wire(monkeypatch, backend=MagicMock())
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    assert backend.add_torrent.call_count == 1
    _args, kwargs = backend.add_torrent.call_args
    assert kwargs["dest_dir"] == "/zim"
    assert kwargs["options"]["bt-hash-check-seed"] == "true"
    # aria2 layer uncapped; Zimi enforces the cap (apply_seed_policy)
    assert kwargs["options"]["seed-ratio"] == "0"


def test_no_seed_when_seeding_disabled(monkeypatch):
    backend = _wire(monkeypatch, seeding=False, backend=MagicMock())
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    backend.add_torrent.assert_not_called()


def test_no_seed_when_torrent_disabled(monkeypatch):
    backend = _wire(monkeypatch, torrent_on=False, backend=MagicMock())
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    backend.add_torrent.assert_not_called()


def test_no_seed_when_ratio_zero_and_not_mirror(monkeypatch):
    backend = _wire(monkeypatch, cap=0.0, backend=MagicMock())
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    backend.add_torrent.assert_not_called()


def test_mirror_seeds_uncapped_even_at_ratio_zero(monkeypatch):
    backend = _wire(monkeypatch, cap=0.0, mirror=True, backend=MagicMock())
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    _args, kwargs = backend.add_torrent.call_args
    assert kwargs["options"]["seed-ratio"] == "0"


def test_no_seed_when_no_torrent_source(monkeypatch):
    backend = _wire(monkeypatch, resolved=None, backend=MagicMock())
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    backend.add_torrent.assert_not_called()


def test_no_seed_when_backend_unavailable(monkeypatch):
    _wire(monkeypatch, backend=None)
    # Must not raise even with no backend
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})


def test_saved_metadata_torrent_file_preferred(monkeypatch):
    backend = _wire(
        monkeypatch,
        backend=MagicMock(),
        meta={"x.zim": {"torrent_file": "/data/bt/torrents/x.torrent"}},
    )
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
    _args, kwargs = backend.add_torrent.call_args
    assert _args[0] == "/data/bt/torrents/x.torrent"


def test_add_torrent_failure_is_swallowed(monkeypatch):
    backend = MagicMock()
    backend.add_torrent.side_effect = RuntimeError("aria2 down")
    _wire(monkeypatch, backend=backend)
    # Best-effort: a seed failure must never break a completed download
    lib._seed_after_http_download({"filename": "x.zim", "url": "https://k/x.zim"})
