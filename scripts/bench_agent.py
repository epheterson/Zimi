#!/usr/bin/env python3
"""Time N search->read agent cycles against a running Zimi (and optionally kiwix-serve).

An "agent cycle" is what a RAG/agent client actually does: search for a term,
take the top hit, then fetch that article's text. We time the search call and
the fetch call separately, plus the end-to-end cycle, and report latency
percentiles over N repetitions.

Usage:
    python3 scripts/bench_agent.py --url http://localhost:8899 --zim <name> --n 50
    # optional apples-to-oranges kiwix-serve comparison on the same ZIM:
    python3 scripts/bench_agent.py --url http://localhost:8899 --zim <name> \
        --compare http://localhost:8901 --compare-book <book> --n 50

Zimi returns JSON (stripped text for /read); kiwix-serve returns HTML. The
comparison measures raw HTTP round-trip latency of each server's search + fetch,
not identical payloads — see the generated benchmark doc for the caveat.
"""

import argparse
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_QUERIES = [
    "water",
    "fire",
    "time",
    "land",
    "house",
    "food",
    "tree",
    "river",
    "stone",
    "light",
    "word",
    "hand",
    "north",
    "green",
    "music",
    "animal",
]


def _get(url, timeout=30):
    """GET a URL; return (body_bytes, elapsed_seconds). Raises on HTTP error."""
    t0 = time.perf_counter()
    with urllib.request.urlopen(url, timeout=timeout) as r:
        body = r.read()
    return body, time.perf_counter() - t0


def _pctiles(samples):
    """min / median / p95 / max / mean, all in milliseconds, from seconds input."""
    if not samples:
        return {}
    ms = sorted(s * 1000.0 for s in samples)
    p95 = ms[min(len(ms) - 1, int(round(0.95 * (len(ms) - 1))))]
    return {
        "n": len(ms),
        "min_ms": round(ms[0], 2),
        "median_ms": round(statistics.median(ms), 2),
        "p95_ms": round(p95, 2),
        "max_ms": round(ms[-1], 2),
        "mean_ms": round(statistics.fmean(ms), 2),
    }


def bench_zimi(base, zim, n, queries):
    """Search -> read cycles against Zimi's JSON API."""
    search_t, read_t, cycle_t = [], [], []
    ok = miss = 0
    for i in range(n):
        q = queries[i % len(queries)]
        c0 = time.perf_counter()
        body, st = _get(f"{base}/search?q={urllib.parse.quote(q)}&zim={zim}&limit=5")
        search_t.append(st)
        results = json.loads(body).get("results", [])
        if not results:
            miss += 1
            continue
        path = results[0]["path"]
        rz = results[0].get("zim", zim)
        _, rt = _get(f"{base}/read?zim={rz}&path={urllib.parse.quote(path)}")
        read_t.append(rt)
        cycle_t.append(time.perf_counter() - c0)
        ok += 1
    return {
        "ok": ok,
        "miss": miss,
        "search": _pctiles(search_t),
        "read": _pctiles(read_t),
        "cycle": _pctiles(cycle_t),
    }


def bench_kiwix(base, book, n, queries):
    """Search -> content cycles against kiwix-serve's HTML/JSON API.

    kiwix-serve: /search?books.name=&pattern= returns an HTML results page;
    /suggest?content=&term= returns JSON with article paths; /content/<book>/<path>
    serves the raw article HTML. We time /search (HTML) and /content (article),
    using /suggest only to discover a valid path (not counted in either metric).
    """
    search_t, fetch_t, cycle_t = [], [], []
    ok = miss = 0
    for i in range(n):
        q = queries[i % len(queries)]
        c0 = time.perf_counter()
        _, st = _get(
            f"{base}/search?books.name={book}&pattern={urllib.parse.quote(q)}&pageLength=5"
        )
        search_t.append(st)
        # Discover a real path via suggest (JSON), not timed as the fetch metric.
        try:
            sug, _ = _get(f"{base}/suggest?content={book}&term={urllib.parse.quote(q)}")
            items = json.loads(sug)
        except Exception:
            items = []
        path = None
        for it in items:
            if it.get("path"):
                path = it["path"]
                break
        if not path:
            miss += 1
            continue
        _, ft = _get(f"{base}/content/{book}/{urllib.parse.quote(path)}")
        fetch_t.append(ft)
        cycle_t.append(time.perf_counter() - c0)
        ok += 1
    return {
        "ok": ok,
        "miss": miss,
        "search": _pctiles(search_t),
        "read": _pctiles(fetch_t),
        "cycle": _pctiles(cycle_t),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="http://localhost:8899", help="Zimi base URL")
    ap.add_argument("--zim", required=True, help="Zimi ZIM name (from /list)")
    ap.add_argument("--n", type=int, default=50, help="cycles (default 50)")
    ap.add_argument("--compare", help="kiwix-serve base URL (optional)")
    ap.add_argument("--compare-book", help="kiwix-serve book name for --compare")
    ap.add_argument("--warmup", type=int, default=3, help="unmeasured warmup cycles")
    ap.add_argument(
        "--queries",
        help="comma-separated query terms (default: a generic English word list). "
        "Pass terms known to hit the target ZIM for a clean read/cycle sample.",
    )
    args = ap.parse_args()

    queries = (
        [q.strip() for q in args.queries.split(",") if q.strip()]
        if args.queries
        else DEFAULT_QUERIES
    )

    # Warm caches/indexes so we measure steady state, not first-touch index build.
    for _ in range(args.warmup):
        try:
            bench_zimi(args.url, args.zim, 1, queries)
        except Exception as e:
            print(f"warmup failed: {e}", file=sys.stderr)
            sys.exit(2)

    out = {
        "n": args.n,
        "queries": len(queries),
        "zimi": bench_zimi(args.url, args.zim, args.n, queries),
    }

    if args.compare:
        book = args.compare_book or args.zim
        try:
            for _ in range(args.warmup):
                bench_kiwix(args.compare, book, 1, queries)
            out["kiwix"] = bench_kiwix(args.compare, book, args.n, queries)
        except Exception as e:
            out["kiwix_error"] = str(e)

    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
