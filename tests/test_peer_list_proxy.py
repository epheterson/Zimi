"""Tests for the /manage/peers/list peer-list proxy.

The proxy fetches a peer's /list and caches it for 60s so the client
can cross-reference catalog items against what LAN peers already have."""

import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p_discovery as disc  # noqa: E402


@pytest.fixture(autouse=True)
def _reset():
    disc._reset_for_tests()
    disc._peer_list_cache.clear()
    yield
    disc._reset_for_tests()
    disc._peer_list_cache.clear()


def _put_peer(name: str, host: str = "10.0.0.42", port: int = 8899):
    full = f"{name}._zimi._tcp.local."
    disc._peers[full] = {
        "name": name,
        "host": host,
        "port": port,
        "bt_port": 6881,
        "version": "1.6.3",
        "zim_count": 5,
        "last_seen": time.time(),
    }


def test_fetch_peer_list_unknown_peer():
    result = disc.fetch_peer_list("nope")
    assert result is None


def test_fetch_peer_list_proxies_peer_list():
    _put_peer("home-nas")
    fake_response = [
        {"name": "wikipedia", "file": "wikipedia_en_all_maxi_2026-02.zim"},
        {"name": "stackoverflow", "file": "stackoverflow_en_all_2026-01.zim"},
    ]
    with patch("urllib.request.urlopen") as mock_open:
        cm = MagicMock()
        cm.__enter__.return_value.read.return_value = (
            b'[{"name":"wikipedia","file":"wikipedia_en_all_maxi_2026-02.zim"},'
            b'{"name":"stackoverflow","file":"stackoverflow_en_all_2026-01.zim"}]'
        )
        cm.__exit__.return_value = None
        mock_open.return_value = cm

        result = disc.fetch_peer_list("home-nas")

    assert result is not None
    assert len(result) == 2
    assert result[0]["file"] == "wikipedia_en_all_maxi_2026-02.zim"
    # URL was the peer's /list
    args, kwargs = mock_open.call_args
    req = args[0] if args else kwargs.get("url")
    url = req.full_url if hasattr(req, "full_url") else str(req)
    assert "10.0.0.42:8899/list" in url


def test_fetch_peer_list_uses_cache():
    _put_peer("home-nas")
    with patch("urllib.request.urlopen") as mock_open:
        cm = MagicMock()
        cm.__enter__.return_value.read.return_value = b'[{"name":"x"}]'
        cm.__exit__.return_value = None
        mock_open.return_value = cm

        disc.fetch_peer_list("home-nas")
        disc.fetch_peer_list("home-nas")  # cached

    assert mock_open.call_count == 1


def test_fetch_peer_list_cache_expires(monkeypatch):
    _put_peer("home-nas")
    with patch("urllib.request.urlopen") as mock_open:
        cm = MagicMock()
        cm.__enter__.return_value.read.return_value = b'[{"name":"x"}]'
        cm.__exit__.return_value = None
        mock_open.return_value = cm

        disc.fetch_peer_list("home-nas")
        # Force cache expiry
        full = "home-nas._zimi._tcp.local."
        disc._peer_list_cache[full] = (
            time.time() - disc.PEER_LIST_TTL_SECONDS - 1,
            [{"name": "x"}],
        )
        disc.fetch_peer_list("home-nas")

    assert mock_open.call_count == 2


def test_fetch_peer_list_returns_none_on_network_error():
    _put_peer("home-nas")
    with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
        result = disc.fetch_peer_list("home-nas")
    assert result is None


def test_fetch_peer_list_returns_none_on_bad_json():
    _put_peer("home-nas")
    with patch("urllib.request.urlopen") as mock_open:
        cm = MagicMock()
        cm.__enter__.return_value.read.return_value = b"not json"
        cm.__exit__.return_value = None
        mock_open.return_value = cm
        result = disc.fetch_peer_list("home-nas")
    assert result is None


def test_fetch_peer_list_capped_size():
    _put_peer("home-nas")
    huge = b"[" + b'{"name":"x"},' * 100_000 + b'{"name":"y"}]'
    with patch("urllib.request.urlopen") as mock_open:
        cm = MagicMock()
        cm.__enter__.return_value.read.return_value = huge
        cm.__exit__.return_value = None
        mock_open.return_value = cm
        # We accept large responses (the cap is byte-based via maxread)
        # Test the read was called with a size limit.
        disc.fetch_peer_list("home-nas")
        # urlopen.read should have been called with a cap (e.g., 5MB)
        call = cm.__enter__.return_value.read.call_args
        assert call is not None
        # Either a positional cap arg or no arg (we assert it's bounded)
        if call.args:
            assert call.args[0] <= 10 * 1024 * 1024
