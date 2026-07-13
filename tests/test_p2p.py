"""Tests for the P2P / BT backend layer.

Coverage:
- Env-var parsing (ZIMI_TORRENT, ZIMI_BT_PORT, ZIMI_STAGING_DIR, ZIMI_BT_BACKEND)
- get_backend() returns None when off, when binary missing, when unknown backend
- Aria2Backend status normalization
- BTBackend abstract — concrete subclasses must implement everything
"""

import os
import sys
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p as p2p  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_singleton():
    p2p._backend_singleton = None
    yield
    p2p._backend_singleton = None


# ────────────────────────────────────────────────────────────────────────────
# Env vars
# ────────────────────────────────────────────────────────────────────────────


def test_torrent_enabled_by_default(monkeypatch):
    """v1.7.0: BT-first is the default so the install base shares load
    with the Kiwix mirrors. Installs without aria2 fall back to HTTP."""
    monkeypatch.delenv("ZIMI_TORRENT", raising=False)
    assert p2p.is_torrent_enabled() is True


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on", ""])
def test_torrent_enabled_truthy_or_default(monkeypatch, val):
    monkeypatch.setenv("ZIMI_TORRENT", val)
    assert p2p.is_torrent_enabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "off"])
def test_torrent_opt_out(monkeypatch, val):
    monkeypatch.setenv("ZIMI_TORRENT", val)
    assert p2p.is_torrent_enabled() is False


def test_peek_backend_never_starts(monkeypatch):
    """Ambient polls use peek_backend — it must return None (not spawn a
    sidecar) when nothing is running, even with BT enabled by default."""
    monkeypatch.delenv("ZIMI_TORRENT", raising=False)
    p2p._backend_singleton = None
    assert p2p.peek_backend() is None


def test_bt_port_default(monkeypatch):
    monkeypatch.delenv("ZIMI_BT_PORT", raising=False)
    assert p2p.get_bt_port() == 6881


def test_bt_port_valid_override(monkeypatch):
    monkeypatch.setenv("ZIMI_BT_PORT", "51413")
    assert p2p.get_bt_port() == 51413


@pytest.mark.parametrize("val", ["abc", "0", "100", "70000", "-1"])
def test_bt_port_invalid_falls_back(monkeypatch, val):
    """Out-of-range or non-integer port falls back to default."""
    monkeypatch.setenv("ZIMI_BT_PORT", val)
    assert p2p.get_bt_port() == p2p.DEFAULT_BT_PORT


def test_staging_dir_default(monkeypatch):
    monkeypatch.delenv("ZIMI_STAGING_DIR", raising=False)
    assert p2p.get_staging_dir("/data") == "/data/staging"


def test_staging_dir_override(monkeypatch):
    monkeypatch.setenv("ZIMI_STAGING_DIR", "/fast-ssd/zimi-tmp")
    assert p2p.get_staging_dir("/data") == "/fast-ssd/zimi-tmp"


def test_backend_default_is_aria2(monkeypatch):
    monkeypatch.delenv("ZIMI_BT_BACKEND", raising=False)
    assert p2p.get_backend_name() == "aria2"


def test_backend_name_normalized(monkeypatch):
    monkeypatch.setenv("ZIMI_BT_BACKEND", "  QBittorrent  ")
    assert p2p.get_backend_name() == "qbittorrent"


# ────────────────────────────────────────────────────────────────────────────
# get_backend() — fail-soft to None
# ────────────────────────────────────────────────────────────────────────────


def test_get_backend_returns_none_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("ZIMI_TORRENT", raising=False)
    assert p2p.get_backend(data_dir=str(tmp_path)) is None


def test_get_backend_returns_none_when_aria2_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    monkeypatch.setattr(p2p.shutil, "which", lambda b: None)
    assert p2p.get_backend(data_dir=str(tmp_path)) is None


def test_get_backend_returns_none_for_unknown_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    monkeypatch.setenv("ZIMI_BT_BACKEND", "torrentmonkey")
    assert p2p.get_backend(data_dir=str(tmp_path)) is None


def test_get_backend_returns_none_when_aria2_rpc_unreachable(monkeypatch, tmp_path):
    """aria2c on PATH but the subprocess fails to start → fall back to HTTP."""
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    monkeypatch.setattr(p2p.shutil, "which", lambda b: "/usr/local/bin/aria2c")
    # Make ensure_running raise — simulates port conflict / startup failure
    fake_proc = MagicMock()
    fake_proc.poll.return_value = None
    monkeypatch.setattr(
        p2p.subprocess,
        "Popen",
        MagicMock(side_effect=OSError("port in use")),
    )
    backend = p2p.get_backend(data_dir=str(tmp_path))
    assert backend is None


def test_get_backend_caches_singleton(monkeypatch, tmp_path):
    """Second get_backend() call returns the same instance, doesn't restart."""
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    monkeypatch.setattr(p2p.shutil, "which", lambda b: "/usr/local/bin/aria2c")
    fake = MagicMock(spec=p2p.Aria2Backend)
    fake.available.return_value = True
    monkeypatch.setattr(p2p, "Aria2Backend", lambda **kw: fake)
    a = p2p.get_backend(data_dir=str(tmp_path))
    b = p2p.get_backend(data_dir=str(tmp_path))
    assert a is b
    assert fake.available.call_count == 1


# ────────────────────────────────────────────────────────────────────────────
# Aria2Backend status normalization
# ────────────────────────────────────────────────────────────────────────────


def _make_backend(tmp_path):
    return p2p.Aria2Backend(
        bt_port=6881,
        rpc_port=16800,
        data_dir=str(tmp_path),
        staging_dir=str(tmp_path / "staging"),
    )


def test_status_maps_aria2_states(tmp_path):
    backend = _make_backend(tmp_path)
    states = {
        "active": "downloading",
        "waiting": "waiting",
        "paused": "paused",
        "error": "error",
        "complete": "complete",
        "removed": "removed",
        "weird": "unknown",
    }
    for aria_state, expected in states.items():
        with patch.object(
            backend,
            "_rpc",
            return_value={
                "status": aria_state,
                "completedLength": "100",
                "totalLength": "1000",
                "downloadSpeed": "0",
                "uploadSpeed": "0",
                "connections": "0",
                "uploadLength": "0",
            },
        ):
            s = backend.status("dummy")
            assert s["state"] == expected


def test_status_computes_ratio(tmp_path):
    backend = _make_backend(tmp_path)
    with patch.object(
        backend,
        "_rpc",
        return_value={
            "status": "complete",
            "completedLength": "1000",
            "totalLength": "1000",
            "uploadLength": "2500",  # 2.5x
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "connections": "5",
        },
    ):
        s = backend.status("x")
        assert abs(s["ratio"] - 2.5) < 0.001


def test_status_handles_zero_total(tmp_path):
    """Don't divide by zero when total is unknown (early download)."""
    backend = _make_backend(tmp_path)
    with patch.object(
        backend,
        "_rpc",
        return_value={
            "status": "active",
            "completedLength": "0",
            "totalLength": "0",
            "uploadLength": "0",
        },
    ):
        s = backend.status("x")
        assert s["ratio"] == 0.0  # max(0, 1) = 1, 0/1 = 0


# ────────────────────────────────────────────────────────────────────────────
# Abstract interface enforcement
# ────────────────────────────────────────────────────────────────────────────


def test_btbackend_cannot_instantiate_abstract():
    with pytest.raises(TypeError):
        p2p.BTBackend()
