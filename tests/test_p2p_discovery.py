"""Tests for LAN peer discovery via mDNS.

The discovery module advertises Zimi over Zeroconf and browses for
peers, caching them with last-seen timestamps. We mock the underlying
Zeroconf APIs so tests run without touching the network."""

import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p_discovery as disc  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_module_state():
    disc._reset_for_tests()
    yield
    disc._reset_for_tests()


def test_get_peers_empty_when_not_started():
    assert disc.get_peers() == []


def test_get_peers_returns_cached():
    disc._peers["zimi-foo._zimi._tcp.local."] = {
        "name": "zimi-foo",
        "host": "192.168.1.50",
        "port": 8899,
        "bt_port": 6881,
        "version": "1.6.3",
        "zim_count": 42,
        "last_seen": time.time(),
    }
    peers = disc.get_peers()
    assert len(peers) == 1
    assert peers[0]["name"] == "zimi-foo"
    assert peers[0]["zim_count"] == 42


def test_stale_peers_pruned():
    now = time.time()
    disc._peers["fresh._zimi._tcp.local."] = {
        "name": "fresh",
        "host": "10.0.0.1",
        "port": 8899,
        "bt_port": 6881,
        "version": "1.6",
        "zim_count": 5,
        "last_seen": now,
    }
    disc._peers["stale._zimi._tcp.local."] = {
        "name": "stale",
        "host": "10.0.0.2",
        "port": 8899,
        "bt_port": 6881,
        "version": "1.6",
        "zim_count": 5,
        "last_seen": now - (disc.PEER_STALE_SECONDS + 10),
    }
    peers = disc.get_peers()
    names = {p["name"] for p in peers}
    assert "fresh" in names
    assert "stale" not in names


def test_start_returns_false_when_zeroconf_unavailable(monkeypatch):
    monkeypatch.setattr(disc, "_import_zeroconf", lambda: None)
    started = disc.start(http_port=8899, bt_port=6881, zim_count=10)
    assert started is False
    assert disc._zc is None


def test_start_creates_zeroconf_with_service_info():
    fake_zc = MagicMock()
    fake_si = MagicMock()
    mod = MagicMock()
    mod.Zeroconf.return_value = fake_zc
    mod.ServiceInfo.return_value = fake_si
    mod.ServiceBrowser = MagicMock()

    with patch.object(disc, "_import_zeroconf", return_value=mod):
        ok = disc.start(http_port=8899, bt_port=6881, zim_count=42, version="1.6.3")

    assert ok is True
    # ServiceInfo built with our type and TXT records
    args, kwargs = mod.ServiceInfo.call_args
    type_arg = args[0] if args else kwargs.get("type_")
    assert type_arg == disc.SERVICE_TYPE
    properties = kwargs.get("properties") or {}
    assert properties[b"version"] == b"1.6.3"
    assert properties[b"zim_count"] == b"42"
    assert properties[b"port"] == b"8899"
    assert properties[b"bt_port"] == b"6881"
    fake_zc.register_service.assert_called_once()
    mod.ServiceBrowser.assert_called_once()


def test_stop_unregisters_and_closes():
    fake_zc = MagicMock()
    fake_si = MagicMock()
    disc._zc = fake_zc
    disc._service_info = fake_si

    disc.stop()

    fake_zc.unregister_service.assert_called_once_with(fake_si)
    fake_zc.close.assert_called_once()
    assert disc._zc is None
    assert disc._service_info is None


def test_stop_is_safe_when_not_started():
    disc.stop()  # no exception


def test_listener_caches_peer_on_add():
    listener = disc._PeerListener()
    fake_zc = MagicMock()
    fake_info = MagicMock()
    fake_info.addresses = [b"\xc0\xa8\x01\x32"]  # 192.168.1.50
    fake_info.port = 8899
    fake_info.properties = {
        b"version": b"1.6.3",
        b"zim_count": b"42",
        b"bt_port": b"6881",
    }
    fake_zc.get_service_info.return_value = fake_info

    listener.add_service(fake_zc, disc.SERVICE_TYPE, "zimi-bob._zimi._tcp.local.")

    peer = disc._peers["zimi-bob._zimi._tcp.local."]
    assert peer["name"] == "zimi-bob"
    assert peer["host"] == "192.168.1.50"
    assert peer["port"] == 8899
    assert peer["bt_port"] == 6881
    assert peer["zim_count"] == 42
    assert peer["version"] == "1.6.3"


def test_listener_skips_self_advertisement():
    listener = disc._PeerListener(self_name="zimi-self")
    fake_zc = MagicMock()
    fake_info = MagicMock()
    fake_info.addresses = [b"\x0a\x00\x00\x01"]
    fake_info.port = 8899
    fake_info.properties = {b"version": b"1.6"}
    fake_zc.get_service_info.return_value = fake_info

    listener.add_service(fake_zc, disc.SERVICE_TYPE, "zimi-self._zimi._tcp.local.")

    assert "zimi-self._zimi._tcp.local." not in disc._peers


def test_listener_remove_drops_peer():
    disc._peers["zimi-gone._zimi._tcp.local."] = {
        "name": "zimi-gone",
        "host": "1.2.3.4",
        "port": 8899,
        "bt_port": 6881,
        "version": "1.6",
        "zim_count": 5,
        "last_seen": time.time(),
    }
    listener = disc._PeerListener()
    listener.remove_service(
        MagicMock(), disc.SERVICE_TYPE, "zimi-gone._zimi._tcp.local."
    )
    assert "zimi-gone._zimi._tcp.local." not in disc._peers


def test_listener_handles_missing_info_gracefully():
    listener = disc._PeerListener()
    fake_zc = MagicMock()
    fake_zc.get_service_info.return_value = None
    listener.add_service(fake_zc, disc.SERVICE_TYPE, "zimi-x._zimi._tcp.local.")
    assert "zimi-x._zimi._tcp.local." not in disc._peers


def test_listener_handles_malformed_txt():
    listener = disc._PeerListener()
    fake_zc = MagicMock()
    fake_info = MagicMock()
    fake_info.addresses = [b"\x0a\x00\x00\x01"]
    fake_info.port = 8899
    fake_info.properties = {b"zim_count": b"not-a-number"}
    fake_zc.get_service_info.return_value = fake_info

    listener.add_service(fake_zc, disc.SERVICE_TYPE, "zimi-bad._zimi._tcp.local.")

    peer = disc._peers["zimi-bad._zimi._tcp.local."]
    assert peer["zim_count"] == 0  # bad value → fallback


def test_start_idempotent():
    fake_zc = MagicMock()
    mod = MagicMock()
    mod.Zeroconf.return_value = fake_zc
    mod.ServiceInfo.return_value = MagicMock()
    mod.ServiceBrowser = MagicMock()

    with patch.object(disc, "_import_zeroconf", return_value=mod):
        disc.start(http_port=8899, bt_port=6881, zim_count=1)
        disc.start(http_port=8899, bt_port=6881, zim_count=1)

    # Only registered once
    assert fake_zc.register_service.call_count == 1


def test_is_enabled_respects_env(monkeypatch):
    monkeypatch.setenv("ZIMI_PEER_DISCOVERY", "0")
    assert disc.is_enabled() is False
    monkeypatch.setenv("ZIMI_PEER_DISCOVERY", "1")
    assert disc.is_enabled() is True
    monkeypatch.delenv("ZIMI_PEER_DISCOVERY", raising=False)
    assert disc.is_enabled() is True  # default-on
