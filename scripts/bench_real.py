"""Real-ZIM timing: cold-start build, cached launch, first-search latency.

Compares warm_indexes() + first-search behavior against the user's actual
question: "takes a lil longer or on a cached launch not longer at all?"

Uses 3 small real ZIMs (gutenberg, zimgit-medicine, zimgit-water)."""

import os
import resource
import shutil
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ZIM_SOURCES = [
    "/Users/elp/Zimi/gutenberg_en_lcc-k_2025-12.zim",
    "/Users/elp/Zimi/zimgit-medicine_en_2024-08.zim",
    "/Users/elp/Zimi/zimgit-water_en_2024-08.zim",
]


def _rss_mb():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024


def _setup_zim_dir(cache_existing=False):
    """Stage ZIMs in a temp dir. If cache_existing, also copy a pre-built
    .zimi/ from the cache_src arg to simulate a cached launch."""
    tmpdir = tempfile.mkdtemp(prefix="zimi-bench-")
    for src in ZIM_SOURCES:
        if os.path.exists(src):
            shutil.copy(src, os.path.join(tmpdir, os.path.basename(src)))
    return tmpdir


def _join_workers(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        live = [
            t
            for t in threading.enumerate()
            if t.daemon and t is not threading.main_thread() and t.is_alive()
        ]
        if not live:
            return
        for t in live:
            t.join(timeout=0.5)


def run_one(label, zim_dir, data_dir):
    os.environ["ZIM_DIR"] = zim_dir
    os.environ["ZIMI_DATA_DIR"] = data_dir
    # Re-import zimi so it picks up env vars on each run.
    for mod in list(sys.modules):
        if mod.startswith("zimi"):
            del sys.modules[mod]
    import zimi  # noqa: F401
    from zimi import server as _server
    from zimi import search as _search

    rss_before = _rss_mb()
    t0 = time.time()
    _server._init()
    _server.warm_indexes()
    _join_workers()
    elapsed = time.time() - t0
    rss_after = _rss_mb()

    # First search timing — query something likely to hit the gutenberg ZIM.
    zims = list(_server.get_zim_files().keys())
    t_search = None
    if zims:
        t1 = time.time()
        try:
            results = _search._title_index_search(zims[0], "the", limit=5)
            t_search = time.time() - t1
            n_results = len(results) if results else 0
        except Exception as e:
            print(f"  search error: {e}")
            n_results = -1

    print(
        f"{label}: warm={elapsed:.2f}s  "
        f"rss_delta={rss_after - rss_before:.1f}MB  "
        f"search1={t_search * 1000 if t_search else -1:.1f}ms  "
        f"search1_n={n_results if t_search else 'n/a'}"
    )
    return elapsed, rss_after - rss_before, t_search


def main():
    # Check ZIM availability
    missing = [s for s in ZIM_SOURCES if not os.path.exists(s)]
    if missing:
        print(f"Missing source ZIMs: {missing}")
        return

    print(
        f"# Real-ZIM bench — {len(ZIM_SOURCES)} ZIMs, "
        f"total {sum(os.path.getsize(s) for s in ZIM_SOURCES) / 1e9:.2f} GB"
    )
    print()

    # Cold start: fresh data dir, no indexes
    print("[COLD START — no indexes built yet]")
    zim_dir = _setup_zim_dir()
    data_dir = tempfile.mkdtemp(prefix="zimi-data-cold-")
    try:
        run_one("  cold", zim_dir, data_dir)
    finally:
        # Don't delete data_dir yet — reuse for cached run
        pass

    print()
    print("[CACHED LAUNCH — indexes already built, same data dir]")
    # Reset Python state but keep data_dir
    run_one("  cached", zim_dir, data_dir)

    # Cleanup
    try:
        shutil.rmtree(zim_dir, ignore_errors=True)
        shutil.rmtree(data_dir, ignore_errors=True)
    except OSError:
        pass


if __name__ == "__main__":
    main()
