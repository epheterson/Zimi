"""_full_catalog is bounded: a page fetch that raises or hangs must never wedge
the whole "check for updates" flow.

Field report: the macOS desktop app's update check "never finishes". The cold
path fetches OPDS pages on worker threads and joined them with no timeout, so a
single connection whose socket timeout never fired (seen only in the frozen app)
blocked the join forever. These tests replace _fetch_kiwix_catalog with fakes
that raise / block on demand and assert _full_catalog returns regardless.
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402

_TOTAL = 2000  # 4 pages at count=500 → page 0 sync, starts [500, 1000, 1500]


def _make_fetch(*, raise_starts=(), hang_starts=(), hang_event=None):
    def fake(query="", lang="eng", count=500, start=0, _background=False):
        if start in raise_starts:
            raise RuntimeError("simulated page fetch failure")
        if start in hang_starts:
            # Block until the test releases us (or the bounded join gives up).
            hang_event.wait()
        items = [{"name": f"e{start}_{i}"} for i in range(500)]
        return _TOTAL, items, None

    return fake


def test_full_catalog_returns_when_a_page_raises(monkeypatch):
    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", _make_fetch(raise_starts={1000}))
    items = lib._full_catalog("")
    # Pages 0, 500, 1500 succeed (1500 items); the raising page (1000) is omitted
    # rather than truncating or crashing the whole fetch.
    assert len(items) == 1500


def test_full_catalog_does_not_hang_on_a_wedged_page(monkeypatch):
    hang_event = threading.Event()
    monkeypatch.setattr(lib, "_FULL_CATALOG_TOTAL_TIMEOUT", 0.5)
    monkeypatch.setattr(
        lib,
        "_fetch_kiwix_catalog",
        _make_fetch(hang_starts={1500}, hang_event=hang_event),
    )
    try:
        t0 = time.monotonic()
        items = lib._full_catalog("")
        elapsed = time.monotonic() - t0

        # Must return within the bounded window, not block on the wedged page.
        assert elapsed < 5.0, f"_full_catalog took {elapsed:.1f}s — join not bounded"
        assert elapsed >= 0.5  # it did wait out the deadline, not skip the join
        # Pages 0, 500, 1000 completed (1500 items); the hung page is omitted.
        assert len(items) == 1500
    finally:
        # Let the abandoned daemon worker exit cleanly.
        hang_event.set()
