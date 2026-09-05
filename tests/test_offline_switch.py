"""ZIMI_OFFLINE — the single air-gap switch.

One env var must silence every internet-bound subsystem regardless of other
config: BT (engine, DHT, boot magnet fetch), the UPnP/SSDP + portcheck NAT
probe, and the desktop Sparkle/WinSparkle appcast. mDNS LAN discovery stays
on by design (link-local multicast, works air-gapped). Everything here is
import-level — no real network, no GUI: the decision functions are tested
directly and the network helpers are stubbed to fail loudly if reached.

(test_offline_mode.py is a different suite: it pins the stale-catalog
serve path with the network dead. This one pins the kill switch itself.)
"""

import hashlib
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
# The desktop launcher lives outside the package (same convention as
# test_winsparkle.py).
sys.path.insert(0, os.path.join(REPO_ROOT, "desktop"))

import zimi.library as library  # noqa: E402
import zimi.p2p as p2p  # noqa: E402
import zimi.p2p_nat as p2p_nat  # noqa: E402
import zimi_desktop  # noqa: E402
import zimi_winsparkle as ws  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every test starts with no offline/BT env or prefs leakage — other
    suites point p2p._prefs_path at their tmp dirs and don't always restore,
    which would make the default-behavior assertions order-dependent."""
    for var in ("ZIMI_OFFLINE", "ZIMI_TORRENT", "ZIMI_BT"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", None)
    yield


# ── is_offline parsing ──────────────────────────────────────────────────────


def test_offline_default_off():
    assert p2p.is_offline() is False


@pytest.mark.parametrize("val", ["1", "true", "yes", "on", "TRUE", " 1 "])
def test_offline_truthy_values(monkeypatch, val):
    monkeypatch.setenv("ZIMI_OFFLINE", val)
    assert p2p.is_offline() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "off", ""])
def test_offline_falsy_values(monkeypatch, val):
    monkeypatch.setenv("ZIMI_OFFLINE", val)
    assert p2p.is_offline() is False


# ── Torrent kill switch ─────────────────────────────────────────────────────


def test_offline_forces_torrent_off(monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert p2p.is_torrent_enabled() is False


def test_offline_outranks_explicit_bt_on(monkeypatch):
    # The whole point of an air-gap switch: it beats every pro-BT setting.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    monkeypatch.setenv("ZIMI_BT", "on")
    assert p2p.is_torrent_enabled() is False


def test_offline_locks_ui_torrent_switch(monkeypatch):
    # The Settings toggle must show as env-locked, not silently vetoed.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert p2p.is_torrent_env_locked() is True


def test_torrent_default_unchanged_without_offline():
    # No ZIMI_OFFLINE → the v1.7.0 BT-on-by-default contract is untouched.
    assert p2p.is_torrent_enabled() is True
    assert p2p.is_torrent_env_locked() is False


def test_offline_get_backend_returns_none(monkeypatch, tmp_path):
    # No engine is ever constructed offline — get_backend bails on the
    # is_torrent_enabled() gate before touching libtorrent.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    p2p._backend_singleton = None
    try:
        assert p2p.get_backend(data_dir=str(tmp_path)) is None
    finally:
        p2p._backend_singleton = None


# ── NAT probe suppression ───────────────────────────────────────────────────


def _forbid(name):
    def _boom(*a, **k):
        raise AssertionError(f"{name} must not run under ZIMI_OFFLINE")

    return _boom


def test_probe_touches_no_network_when_offline(monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    # Any socket-touching helper reached = test failure.
    monkeypatch.setattr(p2p_nat, "_port_listening", _forbid("_port_listening"))
    monkeypatch.setattr(p2p_nat, "discover_gateway", _forbid("discover_gateway"))
    monkeypatch.setattr(p2p_nat, "add_port_mapping", _forbid("add_port_mapping"))
    monkeypatch.setattr(p2p_nat, "get_external_ip", _forbid("get_external_ip"))
    monkeypatch.setattr(
        p2p_nat, "_port_reachable_external", _forbid("_port_reachable_external")
    )
    result = p2p_nat.probe(6881, try_upnp=True)
    # Honest "nothing was checked" shape, same keys as a real probe.
    assert result["bt_port"] == 6881
    assert result["listening"] is False
    assert result["upnp"] == "off"
    assert result["external_ip"] is None
    assert result["reachable"] is None
    # The status cache still updates so /manage/nat-status stays coherent.
    assert p2p_nat.last_status()["bt_port"] == 6881


def test_probe_runs_checks_when_online(monkeypatch):
    # Contrast case: without the flag the probe DOES consult the helpers.
    calls = []
    monkeypatch.setattr(
        p2p_nat, "_port_listening", lambda p: calls.append("listen") or False
    )
    monkeypatch.setattr(
        p2p_nat, "add_port_mapping", lambda p: calls.append("upnp") or False
    )
    monkeypatch.setattr(
        p2p_nat,
        "_port_reachable_external",
        lambda p: calls.append("portcheck") or None,
    )
    p2p_nat.probe(6881, try_upnp=True)
    assert calls == ["listen", "upnp", "portcheck"]


# ── Catalog thumbnail proxy ─────────────────────────────────────────────────

THUMB_URL = "https://library.kiwix.org/catalog/v2/illustration/abc"


def test_thumb_fetch_touches_no_network_when_offline(monkeypatch, tmp_path):
    # /manage/thumb is a pre-auth public route and the catalog grid asks for
    # dozens at once — under the air-gap switch every one of them used to open
    # an outbound connection and wait out its 10 s timeout.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(library._srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        library._KIWIX_REDIRECT_OPENER, "open", _forbid("thumbnail fetch")
    )
    assert library._fetch_thumb(THUMB_URL) == (None, None)


def test_cached_thumb_still_serves_when_offline(monkeypatch, tmp_path):
    # A thumbnail already on disk is local — offline browsing keeps its images.
    monkeypatch.setattr(library._srv, "ZIMI_DATA_DIR", str(tmp_path))
    key = hashlib.md5(THUMB_URL.encode()).hexdigest()
    cache_path = os.path.join(library._thumb_dir(), key)
    with open(cache_path, "wb") as f:
        f.write(b"PNGDATA")
    with open(cache_path + ".meta", "w", encoding="utf-8") as f:
        f.write("image/png")

    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(
        library._KIWIX_REDIRECT_OPENER, "open", _forbid("thumbnail fetch")
    )
    assert library._fetch_thumb(THUMB_URL) == (b"PNGDATA", "image/png")


def test_oversized_thumb_is_dropped_not_cached(monkeypatch, tmp_path):
    """The host is pinned to Kiwix, but nothing bounded what landed in the
    cache dir — a capped read means one bad response can't fill the disk."""
    monkeypatch.setattr(library._srv, "ZIMI_DATA_DIR", str(tmp_path))

    class _FakeResp:
        headers = {"Content-Type": "image/png"}

        def read(self, n=-1):
            # Honour the cap argument the way a real socket read does.
            return b"x" * (n if n and n > 0 else 1)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        library._KIWIX_REDIRECT_OPENER, "open", lambda *a, **k: _FakeResp()
    )
    assert library._fetch_thumb(THUMB_URL) == (None, None)
    assert os.listdir(library._thumb_dir()) == []


def test_in_bounds_thumb_is_cached(monkeypatch, tmp_path):
    monkeypatch.setattr(library._srv, "ZIMI_DATA_DIR", str(tmp_path))

    class _FakeResp:
        headers = {"Content-Type": "image/png"}

        def read(self, n=-1):
            return b"PNGDATA"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        library._KIWIX_REDIRECT_OPENER, "open", lambda *a, **k: _FakeResp()
    )
    assert library._fetch_thumb(THUMB_URL) == (b"PNGDATA", "image/png")
    assert sorted(os.listdir(library._thumb_dir())) == sorted(
        [
            hashlib.md5(THUMB_URL.encode()).hexdigest(),
            hashlib.md5(THUMB_URL.encode()).hexdigest() + ".meta",
        ]
    )


class _StubHandler:
    """Captures what a route answered, without a socket."""

    def __init__(self):
        self.sent: tuple | None = None

    def _json(self, code, body):
        self.sent = (code, body)


def _thumb_route(monkeypatch):
    import zimi.manage as manage
    from urllib.parse import urlparse

    monkeypatch.setattr(manage._srv, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage._srv, "_fetch_thumb", lambda url: (None, None))
    handler = _StubHandler()
    manage.handle_manage_get(
        handler, urlparse(f"/manage/thumb?url={THUMB_URL}"), {"url": [THUMB_URL]}
    )
    assert handler.sent is not None
    return handler.sent


def test_thumb_route_404s_when_offline(monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    code, _body = _thumb_route(monkeypatch)
    assert code == 404  # a dead end, not an upstream failure worth retrying


def test_thumb_route_502s_when_online(monkeypatch):
    code, _body = _thumb_route(monkeypatch)
    assert code == 502


# ── Desktop updater gate (decision functions, no GUI) ───────────────────────


class _FakeConfig:
    def __init__(self, auto_update_check):
        self._v = auto_update_check

    def get(self, key):
        assert key == "auto_update_check"
        return self._v


def test_auto_update_allowed_by_default():
    assert zimi_desktop._auto_update_allowed() is True
    assert zimi_desktop._auto_update_allowed(_FakeConfig(True)) is True


def test_auto_update_blocked_by_offline_env(monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert zimi_desktop._auto_update_allowed() is False
    # Env outranks a config that says yes.
    assert zimi_desktop._auto_update_allowed(_FakeConfig(True)) is False


def test_auto_update_blocked_by_config_key():
    assert zimi_desktop._auto_update_allowed(_FakeConfig(False)) is False


def test_auto_update_config_default_is_true():
    # No behavior change for existing installs: the key defaults to True.
    assert zimi_desktop.ConfigManager.DEFAULTS["auto_update_check"] is True


def test_sparkle_init_is_noop_under_offline(monkeypatch):
    # The offline gate must fire before ANYTHING else — even the platform
    # sniff. If platform.system() is consulted, the gate came too late.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(
        zimi_desktop.platform, "system", _forbid("platform.system"), raising=True
    )
    assert zimi_desktop._init_sparkle_updater() is None


def test_winsparkle_init_is_noop_under_offline(monkeypatch):
    # Never initialize: the DLL is never even looked for, on any platform.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(ws, "_find_dll", _forbid("_find_dll"))
    assert ws.init_updater("1.9.0") is False
    assert ws._dll is None


def test_winsparkle_env_parse_matches_server():
    # The duplicated local parse must agree with zimi.p2p's on the values
    # people actually set.
    for val in ("1", "true", "yes", "on", "0", "false", "no", "off", ""):
        os.environ["ZIMI_OFFLINE"] = val
        try:
            assert ws._offline() == p2p.is_offline(), val
            assert zimi_desktop._env_offline() == p2p.is_offline(), val
        finally:
            del os.environ["ZIMI_OFFLINE"]
