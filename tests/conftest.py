"""Shared test isolation.

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
