"""Tests for the P2P / BT backend layer.

Coverage:
- Env-var parsing (ZIMI_TORRENT, ZIMI_BT_PORT, ZIMI_STAGING_DIR)
- get_backend() returns None when off or when libtorrent is unimportable,
  and caches the libtorrent singleton otherwise
- BTBackend abstract — concrete subclasses must implement everything

The LibtorrentBackend's own behavior (status/list_managed shapes, resume,
remove guards) lives in test_libtorrent_backend.py against the in-memory
fake_lt module.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p as p2p  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_singleton():
    p2p._backend_singleton = None
    yield
    # Stop (not just discard) so a test that really started a session reaps
    # it. Duck-typed because tests may have swapped in a fake without stop().
    backend, p2p._backend_singleton = p2p._backend_singleton, None
    stop = getattr(backend, "stop", None)
    if callable(stop):
        try:
            stop()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _no_real_libtorrent(request, monkeypatch):
    """Tests never start a real libtorrent session unless they inject the
    fake. BT is on by default, so on a machine that actually has the wheel
    an unmocked get_backend() would otherwise build a live session."""
    if "real_engine" in request.keywords:
        return
    monkeypatch.setattr(p2p, "_lt_module", None)
    monkeypatch.setattr(p2p, "_lt_import_failed", True)


# ────────────────────────────────────────────────────────────────────────────
# Env vars
# ────────────────────────────────────────────────────────────────────────────


def test_torrent_enabled_by_default(monkeypatch):
    """v1.7.0: BT-first is the default so the install base shares load
    with the Kiwix mirrors. Installs without libtorrent fall back to HTTP."""
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
    """Ambient polls use peek_backend — it must return None (not start a
    session) when nothing is running, even with BT enabled by default."""
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


# ────────────────────────────────────────────────────────────────────────────
# Concurrency + connection caps
# ────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def _clean_caps_env(monkeypatch):
    for k in ("ZIMI_BT", "ZIMI_MAX_CONCURRENT_DOWNLOADS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", None)


def test_max_active_downloads_default(_clean_caps_env):
    assert p2p.get_max_active_downloads() == p2p.DEFAULT_MAX_ACTIVE_DOWNLOADS
    assert p2p.is_max_active_downloads_env_locked() is False


def test_max_active_downloads_legacy_env_wins_and_locks(_clean_caps_env, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "7")
    assert p2p.get_max_active_downloads() == 7
    assert p2p.is_max_active_downloads_env_locked() is True


def test_max_active_downloads_bt_subkey(_clean_caps_env, monkeypatch):
    monkeypatch.setenv("ZIMI_BT", "on,active=6")
    assert p2p.get_max_active_downloads() == 6
    assert p2p.is_max_active_downloads_env_locked() is True


@pytest.mark.parametrize("raw,expected", [("0", 1), ("99", 20), ("x", 4)])
def test_max_active_downloads_clamps(_clean_caps_env, monkeypatch, raw, expected):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", raw)
    assert p2p.get_max_active_downloads() == expected


def test_max_connections_default(_clean_caps_env):
    assert p2p.get_bt_max_connections() == p2p.DEFAULT_MAX_CONNECTIONS
    assert p2p.is_bt_max_connections_env_locked() is False


def test_max_connections_bt_subkey_wins_and_locks(_clean_caps_env, monkeypatch):
    monkeypatch.setenv("ZIMI_BT", "on,conns=500")
    assert p2p.get_bt_max_connections() == 500
    assert p2p.is_bt_max_connections_env_locked() is True


@pytest.mark.parametrize("raw,expected", [("5", 10), ("99999", 2000), ("x", 200)])
def test_max_connections_clamps(_clean_caps_env, monkeypatch, raw, expected):
    monkeypatch.setenv("ZIMI_BT", f"on,conns={raw}")
    assert p2p.get_bt_max_connections() == expected


def test_caps_read_from_persisted_prefs(_clean_caps_env, monkeypatch, tmp_path):
    prefs = tmp_path / "prefs.json"
    monkeypatch.setattr(p2p, "_prefs_path", str(prefs))
    assert p2p.set_pref("max_active_downloads", 9)
    assert p2p.set_pref("bt_max_connections", 321)
    assert p2p.get_max_active_downloads() == 9
    assert p2p.get_bt_max_connections() == 321
    # A pref (no env) leaves the UI control unlocked.
    assert p2p.is_max_active_downloads_env_locked() is False
    assert p2p.is_bt_max_connections_env_locked() is False


# ────────────────────────────────────────────────────────────────────────────
# get_backend() — fail-soft to None, else the libtorrent singleton
# ────────────────────────────────────────────────────────────────────────────


def test_get_backend_returns_none_when_disabled(monkeypatch, tmp_path):
    # BT defaults ON since v1.7.0 — disabled now means an explicit opt-out.
    monkeypatch.setenv("ZIMI_TORRENT", "0")
    assert p2p.get_backend(data_dir=str(tmp_path)) is None


def test_get_backend_none_without_libtorrent(monkeypatch, tmp_path):
    monkeypatch.setattr(p2p, "_backend_singleton", None)
    monkeypatch.setattr(p2p, "_lt_module", None)
    monkeypatch.setattr(p2p, "_lt_import_failed", True)
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    assert p2p.get_backend(data_dir=str(tmp_path)) is None


def test_get_backend_libtorrent_singleton(monkeypatch, tmp_path):
    sys.path.insert(0, os.path.dirname(__file__))
    import fake_lt

    monkeypatch.setattr(p2p, "_backend_singleton", None)
    monkeypatch.setattr(p2p, "_lt_module", fake_lt)
    monkeypatch.setattr(p2p, "_lt_import_failed", False)
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    b1 = p2p.get_backend(data_dir=str(tmp_path))
    b2 = p2p.get_backend(data_dir=str(tmp_path))
    assert isinstance(b1, p2p.LibtorrentBackend)
    assert b1 is b2
    p2p.shutdown_backend()


# ────────────────────────────────────────────────────────────────────────────
# Abstract interface enforcement
# ────────────────────────────────────────────────────────────────────────────


def test_btbackend_cannot_instantiate_abstract():
    with pytest.raises(TypeError):
        p2p.BTBackend()
