"""Shared test isolation.

Tests never touch the network around them: a test server that starts
BitTorrent must not ask the router to open a port (one did, 2026-09-28,
and left a 24-hour UPnP mapping on the developer's router). UPnP and
NAT-PMP are off for every test except the ones about them.

Zimi keeps open archives in pools keyed by a ZIM's short name. The running
server clears them whenever the library changes (a download, an update, a
refresh); a test that points the server at a new library directly does
not, so a later test whose fixture ZIM has the same short name as an
earlier one's read the earlier file. Each passed alone and failed in the
full suite. Every test starts with empty pools.
"""

import pytest


@pytest.fixture(autouse=True)
def _fresh_archive_pools():
    try:
        from zimi import server as _srv
    except Exception:
        yield
        return
    for pool_name, lock_name, locks_name in (
        ("_archive_pool", "_archive_lock", None),
        ("_fts_pool", "_fts_pool_lock", "_fts_zim_locks"),
        ("_suggest_pool", "_suggest_pool_lock", "_suggest_zim_locks"),
    ):
        pool = getattr(_srv, pool_name, None)
        lock = getattr(_srv, lock_name, None)
        if pool is None or lock is None:
            continue
        with lock:
            pool.clear()
            if locks_name and getattr(_srv, locks_name, None) is not None:
                getattr(_srv, locks_name).clear()
    yield


_UPNP_TEST_MODULES = ("test_p2p_nat", "test_offline_switch")


@pytest.fixture(autouse=True)
def _no_router_changes(request, monkeypatch):
    if request.module.__name__.rsplit(".", 1)[-1] in _UPNP_TEST_MODULES:
        yield
        return
    try:
        from zimi import p2p, p2p_nat
    except Exception:
        yield
        return
    monkeypatch.setattr(p2p, "is_upnp_enabled", lambda: False)
    monkeypatch.setattr(p2p_nat, "add_port_mapping", lambda port: False)
    yield
