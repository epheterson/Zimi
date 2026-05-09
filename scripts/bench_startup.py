"""Benchmark warm_indexes() — counts thread spawns and peak concurrent
Archive opens. Run on each branch and compare.

Usage: python3 scripts/bench_startup.py [N]
  N = synthetic ZIM count (default 5)
"""

from __future__ import annotations

import os
import sys
import threading
import time
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import server as _server  # noqa: E402


def main(n_zims: int = 5) -> None:
    zim_files = {f"zim{i}": f"/fake/zim{i}.zim" for i in range(n_zims)}

    spawned_threads: list[str] = []
    real_thread = threading.Thread

    def _capture_thread(*args, **kwargs):
        name = kwargs.get("name", "")
        spawned_threads.append(name)
        return real_thread(*args, **kwargs)

    archive_active = [0]
    archive_peak = [0]
    archive_total = [0]
    archive_lock = threading.Lock()

    class _StubArchive:
        uuid = "stub-uuid"
        all_entry_count = 0
        entry_count = 0

        def __init__(self):
            with archive_lock:
                archive_active[0] += 1
                archive_total[0] += 1
                if archive_active[0] > archive_peak[0]:
                    archive_peak[0] = archive_active[0]

        def __del__(self):
            with archive_lock:
                archive_active[0] -= 1

    def _stub_open(path):
        return _StubArchive()

    # Stub everything that touches disk/network/libzim. We're measuring the
    # threading + Archive-open shape of warm_indexes(), not the real builds.
    patches = [
        mock.patch.object(_server, "get_zim_files", return_value=zim_files),
        mock.patch.object(_server, "get_hot_zims", return_value=[]),
        mock.patch.object(_server, "open_archive", side_effect=_stub_open),
        mock.patch.object(_server, "_build_all_title_indexes", lambda: None),
        mock.patch.object(_server, "_build_all_qid_indexes", lambda: None),
        mock.patch.object(_server, "_suggest_cache_restore", return_value=0),
        mock.patch.object(_server, "_get_suggest_archive", lambda name: None),
        mock.patch.object(_server, "_get_fts_archive", lambda name: None),
        mock.patch.object(_server, "_get_title_db", lambda name: None),
        mock.patch.object(_server, "get_archive", lambda name: _StubArchive()),
        mock.patch.object(_server.threading, "Thread", side_effect=_capture_thread),
    ]
    if hasattr(_server, "SuggestionSearcher"):
        patches.append(
            mock.patch.object(
                _server,
                "SuggestionSearcher",
                new=mock.MagicMock(return_value=mock.MagicMock()),
            )
        )

    t0 = time.time()
    with mock.MagicMock() as _:  # placeholder; real patches below
        pass

    # Apply all patches manually so we can join the worker before unpatching.
    started = []
    try:
        for p in patches:
            p.start()
            started.append(p)
        _server.warm_indexes()
        # Join the spawned worker (if named).
        for t in threading.enumerate():
            if t.name == "zimi-startup-worker" or t.name.startswith("Thread-"):
                t.join(timeout=10.0)
    finally:
        for p in reversed(started):
            try:
                p.stop()
            except Exception:
                pass

    elapsed = time.time() - t0

    print(f"# bench_startup with N={n_zims} ZIMs")
    print(f"threads spawned by warm_indexes: {len(spawned_threads)}")
    for name in spawned_threads:
        print(f"  - {name!r}")
    print(f"total Archive opens: {archive_total[0]}")
    print(f"peak concurrent Archive opens: {archive_peak[0]}")
    print(f"wall time: {elapsed:.3f}s")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    main(n)
