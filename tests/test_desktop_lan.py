"""The desktop app's "Open Zimi on other devices on this network" setting
(issue #90), and what a device on that network may then do.

The bind choice is unit-tested. The trust point is tested for real: a server
bound the way the desktop binds with the setting on, reached over this
machine's own LAN address, so the socket peer is a genuine non-loopback
address and nothing about the client is stubbed.

Run: pytest tests/test_desktop_lan.py -v
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import desktop  # noqa: E402
from zimi import http as zhttp  # noqa: E402
from zimi import manage  # noqa: E402
from zimi import p2p_discovery  # noqa: E402
import zimi.server as server  # noqa: E402


_DEFAULTS = dict(desktop.ConfigManager.DEFAULTS)


class _Config:
    """ConfigManager's get/set/save, without touching the real config.json."""

    def __init__(self, **values):
        self._data = dict(_DEFAULTS, **values)
        self.saved = False
        self.is_first_run = False

    def get(self, key):
        return self._data.get(key)

    def set(self, key, value):
        self._data[key] = value

    def save(self):
        self.saved = True


@pytest.fixture
def no_zimi_host(monkeypatch):
    monkeypatch.delenv("ZIMI_HOST", raising=False)


# ── which address the server binds ───────────────────────────────────────────


def test_off_by_default_binds_this_machine_only(no_zimi_host):
    assert _DEFAULTS["lan_access"] is False
    assert desktop._bind_host(_Config()) == "127.0.0.1"


def test_on_binds_every_interface(no_zimi_host):
    assert desktop._bind_host(_Config(lan_access=True)) == "0.0.0.0"


@pytest.mark.parametrize("setting", [False, True])
def test_zimi_host_wins_either_way(monkeypatch, setting):
    monkeypatch.setenv("ZIMI_HOST", "192.168.137.1")
    assert desktop._bind_host(_Config(lan_access=setting)) == "192.168.137.1"


def test_blank_zimi_host_is_unset(monkeypatch):
    monkeypatch.setenv("ZIMI_HOST", "  ")
    assert desktop._bind_host(_Config()) == "127.0.0.1"


@pytest.mark.parametrize("setting,host", [(False, "127.0.0.1"), (True, "0.0.0.0")])
def test_browser_and_headless_modes_bind_the_same_way(
    no_zimi_host, monkeypatch, tmp_path, setting, host
):
    """--browser and --serve build their own server; both honour the setting."""
    monkeypatch.setattr(desktop, "ConfigManager", lambda: _Config(lan_access=setting))
    seen = []
    monkeypatch.setattr(
        desktop, "_serve", lambda zim_dir, port, on_ready, host="?": seen.append(host)
    )
    for argv in (
        ["Zimi", "--browser", "--zim-dir", str(tmp_path)],
        ["Zimi", "--serve", "--zim-dir", str(tmp_path)],
    ):
        monkeypatch.setattr(sys, "argv", argv)
        (desktop._run_in_browser if "--browser" in argv else desktop._serve_headless)()
    assert seen == [host, host]


def test_port_probe_uses_the_bind_address():
    port = desktop._find_open_port(0, 0, host="0.0.0.0")
    assert port == 0


# ── the settings bridge ──────────────────────────────────────────────────────


def test_turning_it_on_saves_and_asks_for_a_restart(no_zimi_host):
    cfg = _Config()
    api = desktop.DesktopAPI(cfg, {})
    assert api.get_config()["lan_access"] is False
    assert api.save_config({"lan_access": True}) is True
    assert cfg.get("lan_access") is True and cfg.saved
    # Same value again: nothing to restart for.
    assert api.save_config({"lan_access": True}) is False


def test_env_locks_the_toggle(monkeypatch):
    monkeypatch.setenv("ZIMI_HOST", "0.0.0.0")
    assert desktop.DesktopAPI(_Config(), {}).get_config()["lan_access_env"] is True


def test_addresses_only_while_open(no_zimi_host, monkeypatch):
    monkeypatch.setattr(
        p2p_discovery, "local_ipv4s", lambda: ["10.0.0.5", "192.168.137.1"]
    )
    assert desktop.DesktopAPI(_Config(), {}).lan_addresses() == []
    assert desktop.DesktopAPI(_Config(lan_access=True), {}).lan_addresses() == [
        "10.0.0.5",
        "192.168.137.1",
    ]


def test_addresses_follow_a_named_zimi_host(monkeypatch):
    monkeypatch.setenv("ZIMI_HOST", "192.168.137.1")
    assert desktop.DesktopAPI(_Config(), {}).lan_addresses() == ["192.168.137.1"]
    monkeypatch.setenv("ZIMI_HOST", "127.0.0.1")
    assert desktop.DesktopAPI(_Config(lan_access=True), {}).lan_addresses() == []


def test_local_ipv4s_keeps_the_hotspot_adapter(monkeypatch):
    """The routed address first, then every other adapter; never loopback."""
    monkeypatch.setattr(p2p_discovery, "_local_ip", lambda: "10.0.0.5")
    monkeypatch.setattr(
        p2p_discovery.socket,
        "getaddrinfo",
        lambda *a, **k: [
            (2, 1, 6, "", (ip, 0)) for ip in ("127.0.0.1", "10.0.0.5", "192.168.137.1")
        ],
    )
    assert p2p_discovery.local_ipv4s() == ["10.0.0.5", "192.168.137.1"]


# ── what a device on the network can do ──────────────────────────────────────


def _lan_ip():
    for ip in p2p_discovery.local_ipv4s():
        return ip
    return None


@pytest.fixture
def lan_server(no_zimi_host):
    """A server bound exactly as the desktop binds it with the setting on,
    with the desktop's manage switch, and no admin password yet. The desktop
    never mints a setup key (only `zimi serve` prints one), so none exists."""
    ip = _lan_ip()
    if not ip:
        pytest.skip("this machine has no LAN address")
    d = tempfile.mkdtemp(prefix="zimi-desktop-lan-")
    saved = (server.ZIM_DIR, server.ZIMI_DATA_DIR, server.ZIMI_MANAGE)
    server.ZIM_DIR = d
    server.ZIMI_DATA_DIR = os.path.join(d, ".zimi")
    os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
    server.ZIMI_MANAGE = True
    os.environ.pop("ZIMI_MANAGE_PASSWORD", None)
    manage._env_pw_hash_cache = None
    server.load_cache()
    srv = ThreadingHTTPServer(
        (desktop._bind_host(_Config(lan_access=True)), 0), zhttp.ZimHandler
    )
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    yield f"http://{ip}:{port}", f"http://127.0.0.1:{port}"
    srv.shutdown()
    srv.server_close()
    server.ZIM_DIR, server.ZIMI_DATA_DIR, server.ZIMI_MANAGE = saved
    manage._env_pw_hash_cache = None
    shutil.rmtree(d, ignore_errors=True)


def _call(url, body=None, headers=None):
    req = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")


def test_a_lan_visitor_reads_but_does_not_become_admin(lan_server):
    lan, local = lan_server
    # Reading is the point of the setting.
    assert _call(f"{lan}/health")[0] == 200
    assert _call(f"{lan}/list")[0] == 200
    # Manage is locked, and the takeover call is refused, with or without a
    # guessed setup key: the desktop has none to match.
    status, body = _call(f"{lan}/manage/status")
    assert status == 403, body
    for headers in ({}, {"X-Zimi-Setup-Key": "AAAA-BBBB-CCCC"}):
        status, body = _call(
            f"{lan}/manage/set-password", {"password": "attacker-pw"}, headers
        )
        assert status == 403, body
    assert not manage._get_manage_password_hash()
    # The owner, at the machine, still can.
    status, body = _call(f"{local}/manage/set-password", {"password": "owner-pw-123"})
    assert status == 200, body


def test_with_a_password_the_lan_visitor_needs_it(lan_server):
    lan, local = lan_server
    assert _call(f"{local}/manage/set-password", {"password": "owner-pw-123"})[0] == 200
    assert _call(f"{lan}/manage/status")[0] == 401
    ok = _call(f"{lan}/manage/status", headers={"Authorization": "Bearer owner-pw-123"})
    assert ok[0] == 200, ok
