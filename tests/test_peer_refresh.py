"""The peer-refresh loop: discovered peers must OUTLIVE the stale window.

Zeroconf only fires update_service when a record changes, so before the
refresh loop every peer aged out of get_peers() PEER_STALE_SECONDS after
its one add_service event — Nearby went dark two minutes into a session
(BROWSE_REFRESH_SECONDS existed but nothing used it). These tests drive
_refresh_loop against a mocked Zeroconf, no network.
"""

import os
import socket
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p_discovery as disc  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_module_state():
    disc._reset_for_tests()
    yield
    disc._reset_for_tests()


class _FakeInfo:
    def __init__(self, host="10.0.0.9", port=8896):
        self.addresses = [socket.inet_aton(host)]
        self.port = port
        self.properties = {
            b"version": b"1.9",
            b"zim_count": b"3",
            b"bt_port": b"6881",
        }


class _FakeZc:
    """get_service_info answers for live services, None for vanished ones."""

    def __init__(self, live):
        self.live = set(live)
        self.queries = []

    def get_service_info(self, type_, name):
        self.queries.append(name)
        return _FakeInfo() if name in self.live else None


def _seed_peer(name, last_seen):
    disc._peers[name] = {
        "name": name.split("._")[0],
        "host": "10.0.0.9",
        "port": 8896,
        "bt_port": 6881,
        "version": "1.9",
        "zim_count": 3,
        "last_seen": last_seen,
    }


def _run_loop_once(zc, listener):
    """One refresh pass: interval 0 so wait() returns immediately, stop set
    by a timer after the first sweep has had time to run."""
    stop = threading.Event()
    t = threading.Thread(
        target=disc._refresh_loop, args=(zc, listener, stop), daemon=True
    )
    orig = disc.BROWSE_REFRESH_SECONDS
    disc.BROWSE_REFRESH_SECONDS = 0.01
    try:
        t.start()
        deadline = time.time() + 5
        while not zc.queries and time.time() < deadline:
            time.sleep(0.01)
    finally:
        stop.set()
        t.join(timeout=5)
        disc.BROWSE_REFRESH_SECONDS = orig
    assert not t.is_alive(), "refresh loop did not stop on the event"


def test_live_peer_last_seen_refreshed():
    name = "zimi-seed._zimi._tcp.local."
    old = time.time() - (disc.PEER_STALE_SECONDS - 5)  # nearly stale
    _seed_peer(name, old)
    listener = disc._PeerListener(self_name="zimi-me")
    _run_loop_once(_FakeZc(live=[name]), listener)
    assert disc._peers[name]["last_seen"] > old, "refresh did not restamp last_seen"
    # And the peer therefore survives the stale cutoff.
    assert [p["name"] for p in disc.get_peers()] == ["zimi-seed"]


def test_vanished_peer_not_refreshed_and_ages_out():
    name = "zimi-gone._zimi._tcp.local."
    old = time.time() - (disc.PEER_STALE_SECONDS + 10)  # already stale
    _seed_peer(name, old)
    listener = disc._PeerListener(self_name="zimi-me")
    zc = _FakeZc(live=[])  # answers None: the peer is really gone
    _run_loop_once(zc, listener)
    assert name in zc.queries, "loop never re-confirmed the peer"
    assert disc._peers[name]["last_seen"] == old
    assert disc.get_peers() == []  # pruned, not resurrected


def test_stop_clears_refresh_event():
    # stop() must end the loop even when zeroconf was never really started.
    evt = threading.Event()
    disc._refresh_stop = evt
    disc.stop()
    assert evt.is_set()
    assert disc._refresh_stop is None
