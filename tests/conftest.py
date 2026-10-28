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

The rate limiter's buckets are process-wide too, keyed by client IP, and
every in-process test server is 127.0.0.1. A fast run (the CI runner)
spent the minute's budget in earlier tests, and a later test's search or
catalog came back 429: "no results", a missing app. Every test starts
with a full budget.

Search answers are cached for fifteen minutes by query, and title indexes
held open by ZIM name: the same short names again. Every test starts with
neither (cleared in memory only; the server's own clear also writes the
suggest cache to whatever data dir the last test left behind).
"""

import os

import pytest

# The best answer card is off unless the operator turns it on; its tests are
# about the card, so the suite runs with it on (set before zimi.http reads it).
os.environ.setdefault("ZIMI_BEST_ANSWER", "1")
# Zimi's own ZIMs (ZimiGames, the Almanac) would join every test library, a single-ZIM
# library among them; tests/test_ownzims.py turns them on for its own.
os.environ.setdefault("ZIMI_BUILTIN_ZIMS", "0")


@pytest.fixture(autouse=True, scope="session")
def _cheap_password_hashing():
    """Every password set or checked costs 600,000 PBKDF2 rounds, a fraction
    of a second by design, and the access tests do it hundreds of times. In
    this process a hash is made and checked with the same count, so the
    tests lose nothing at 1,000. Servers a test starts as `zimi serve` keep
    the real count; none of them reads a password this process wrote."""
    try:
        from zimi import manage
    except Exception:
        yield
        return
    real = manage._PW_ITERATIONS
    manage._PW_ITERATIONS = 1_000
    yield
    manage._PW_ITERATIONS = real


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


@pytest.fixture(autouse=True)
def _fresh_rate_budget():
    try:
        from zimi import http as _http
    except Exception:
        yield
        return
    with _http._rate_lock:
        for buckets in (
            _http._rate_buckets,
            _http._rate_buckets_content,
            _http._rate_buckets_keep,
            _http._rate_buckets_login,
            _http._authed_cache,
        ):
            buckets.clear()
    yield


@pytest.fixture(autouse=True)
def _fresh_search_state():
    try:
        from zimi import search as _search
    except Exception:
        yield
        return
    with _search._search_cache_lock:
        _search._search_cache.clear()
    with _search._suggest_cache_lock:
        _search._suggest_cache.clear()
    for name in list(_search._title_db_pool):
        _search._close_title_db(name)
    yield


@pytest.fixture(autouse=True)
def _fieldguide_switch(request, monkeypatch):
    """The Field Guide is off by default (ZIMI_FIELDGUIDE); a test whose
    premise is the guide opts in with @pytest.mark.fieldguide_on (or a
    module-level pytestmark). Every other test runs with it off."""
    if request.node.get_closest_marker("fieldguide_on"):
        monkeypatch.setenv("ZIMI_FIELDGUIDE", "1")
    else:
        monkeypatch.delenv("ZIMI_FIELDGUIDE", raising=False)
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
