"""Memory benchmark for warm_indexes() — peak RSS during the synthetic
warm phase. Stub Archives carry a configurable payload to simulate the
mmap footprint of real ZIMs without needing actual ZIM files.

Usage: python3 scripts/bench_memory.py [N] [PAYLOAD_MB]
  N            = synthetic ZIM count (default 70)
  PAYLOAD_MB   = bytes-per-stub-Archive payload (default 10MB)

Reports peak RSS during warm phase via resource.getrusage."""

from __future__ import annotations

import os
import resource
import sys
import threading
import time
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import server as _server  # noqa: E402


def _rss_mb() -> float:
    """Current process RSS in MB. macOS reports bytes, Linux reports KB."""
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return rss / (1024 * 1024)
    return rss / 1024


def main(n_zims: int = 70, payload_mb: int = 10) -> None:
    payload_bytes = payload_mb * 1024 * 1024
    zim_files = {f"zim{i}": f"/fake/zim{i}.zim" for i in range(n_zims)}

    archive_count = [0]
    archive_lock = threading.Lock()

    class _PayloadArchive:
        """Carries a real allocation so RSS reflects 'open' archives."""

        uuid = "stub-uuid"
        all_entry_count = 0
        entry_count = 0

        def __init__(self):
            # Allocate a real chunk so peak RSS captures the cost.
            self._payload = bytearray(payload_bytes)
            with archive_lock:
                archive_count[0] += 1

    def _stub_open(path):
        return _PayloadArchive()

    rss_baseline = _rss_mb()

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
        mock.patch.object(_server, "get_archive", lambda name: _PayloadArchive()),
    ]
    if hasattr(_server, "SuggestionSearcher"):
        patches.append(
            mock.patch.object(
                _server,
                "SuggestionSearcher",
                new=mock.MagicMock(return_value=mock.MagicMock()),
            )
        )

    started = []
    t0 = time.time()
    try:
        for p in patches:
            p.start()
            started.append(p)
        _server.warm_indexes()
        # Wait for the worker (named on the new branch, anonymous on old).
        deadline = time.time() + 15.0
        while time.time() < deadline:
            running = [
                t
                for t in threading.enumerate()
                if t.name == "zimi-startup-worker"
                or t.daemon
                and t is not threading.main_thread()
                and t.is_alive()
            ]
            running = [t for t in running if t.is_alive()]
            if not running:
                break
            for t in running:
                t.join(timeout=0.2)
    finally:
        for p in reversed(started):
            try:
                p.stop()
            except Exception:
                pass

    rss_peak = _rss_mb()
    elapsed = time.time() - t0

    print(f"# bench_memory N={n_zims} payload={payload_mb}MB/archive")
    print(f"baseline RSS: {rss_baseline:.1f} MB")
    print(f"peak RSS:     {rss_peak:.1f} MB")
    print(f"delta:        {rss_peak - rss_baseline:.1f} MB")
    print(f"archives instantiated: {archive_count[0]}")
    print(f"wall time:    {elapsed:.2f}s")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 70
    p = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    main(n, p)
