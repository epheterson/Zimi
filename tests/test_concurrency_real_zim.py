"""Concurrent real-libzim access — the segfault guard.

libzim (SWIG C++) is NOT thread-safe: two threads reading one Archive object
segfault the whole interpreter with no Python traceback. The rest of the suite
mocks archives, so a regression that drops _zim_lock or shares a pooled handle
across threads (exactly the v1.7.3 `_qid_passive_extract` P0) sails through 642
green tests and crashes in production.

This test builds one tiny REAL ZIM and hammers the real read paths from many
threads. A segfault kills the test process, so "the process is still alive at
the assert" IS the pass condition.
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402

import zimi.server as server  # noqa: E402
import zimi.search as search  # noqa: E402
import zimi.interlang as interlang  # noqa: E402


@pytest.fixture()
def real_zim_dir(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "survival_en_2026-06.zim"))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    # Reset caches/pools so the fixture is what gets opened.
    server.load_cache(force=True)
    yield str(zdir)
    # Drop pooled handles so the tmp ZIM can be cleaned up.
    try:
        server._archive_pool.clear()
    except Exception:
        pass


def _hammer(fn, threads=16, iters=8):
    errors = []

    def worker():
        try:
            for _ in range(iters):
                fn()
        except Exception as e:  # a real error is a finding; a segfault kills us
            errors.append(repr(e))

    ts = [threading.Thread(target=worker) for _ in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return errors


def test_concurrent_reads_same_zim_survive(real_zim_dir):
    """Many threads reading the SAME real ZIM must not crash the process."""
    name = "survival"
    errors = _hammer(lambda: search.read_article(name, "A/Water"))
    assert not errors, errors[:3]
    # Sanity: a read actually returns the article content.
    out = search.read_article(name, "A/Water")
    assert "purification" in str(out).lower()


def test_concurrent_search_and_read_mixed(real_zim_dir):
    """Search and read racing on the same ZIM — the real request mix."""
    name = "survival"
    import random

    def mixed():
        if random.random() < 0.5:
            search.search_all("water", limit=5)
        else:
            search.read_article(name, "A/Fire")

    errors = _hammer(mixed, threads=16, iters=6)
    assert not errors, errors[:3]


def test_passive_qid_extract_concurrent_with_reads(real_zim_dir):
    """The v1.7.3 P0: the passive Q-ID extractor ran on a daemon thread and
    touched the SHARED pooled archive while requests read it. It now opens its
    own handle — this hammers both at once to prove no shared-handle crash."""
    name = "survival"

    def mixed():
        import random

        if random.random() < 0.5:
            interlang._qid_passive_extract(name, "A/Shelter")
        else:
            search.read_article(name, "A/Shelter")

    errors = _hammer(mixed, threads=16, iters=6)
    assert not errors, errors[:3]
