#!/usr/bin/env python3
"""How fast is places autocomplete on a very big map?

    python3 scripts/bench_place_suggest.py [places] [keystrokes]

Builds a synthetic towns index of ``places`` places (default 2,000,000, the
size of an every-village world map; the real world map labels about 116,000
cities and towns) in a temporary data dir, in the file format
zimi.mapplaces reads, then types prefixes of every length against it the way
a person does and prints the p50 / p95 / p99 / worst time of
mapplaces.suggest, per length of prefix and overall.

Names are made of syllables drawn Zipf-like, so many places share a start
("San", "Spring", "New") as real ones do. Region and country come from a
small table, not zimi.regions (locating 2 million points would take as long
as the benchmark is worth).
"""

import os
import random
import sqlite3
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as srv  # noqa: E402
from zimi import mapplaces, mapsearch  # noqa: E402

# A thousand pronounceable syllables, a few of them very common (Zipf), and a
# short list of starts that real names share by the tens of thousands.
_CONSONANTS, _VOWELS = "bcdfghjklmnprstvwz", "aeiou"
SYLLABLES = [c + v + e for c in _CONSONANTS for v in _VOWELS for e in ("", "n", "r", "l", "s", "m", "nd", "rt")][:1000]
COMMON_STARTS = ("San ", "Santa ", "Saint ", "St ", "New ", "Mount ", "Port ", "North ", "South ", "East ", "West ", "Lake ", "Fort ")
REGIONS = [
    ("Illinois", "IL", "United States", "US"),
    ("Missouri", "MO", "United States", "US"),
    ("Texas", "TX", "United States", "US"),
    ("Bavaria", "", "Germany", "DE"),
    ("Ontario", "ON", "Canada", "CA"),
    ("Andalusia", "", "Spain", "ES"),
    ("Maharashtra", "", "India", "IN"),
    ("Shandong", "", "China", "CN"),
]
NAME = "bench_places"


def _name(rng, zipf):
    parts = [SYLLABLES[min(int(rng.paretovariate(zipf)) - 1, len(SYLLABLES) - 1)] for _ in range(rng.choice((2, 2, 3)))]
    return "".join(parts).capitalize()


def build(path, count, rng):
    rows, seen = [], 0
    t0 = time.time()
    for i in range(count):
        name = _name(rng, 0.9)
        if rng.random() < 0.25:  # "Santa Maria", "Mount Kirkford"
            name = rng.choice(COMMON_STARTS) + name
        cls = "city" if rng.random() < 0.05 else "town"
        weight = mapplaces._tag_rank({"class": cls, "rank": str(rng.randint(7, 22))})
        region, postal, country, iso = rng.choice(REGIONS)
        lat, lng = rng.uniform(-60, 70), rng.uniform(-180, 180)
        for word in set(mapsearch.normalize_text(name).split()):
            row = (word, name, cls, lat, lng, region, postal, country, iso, "", weight)
            rows.append(row)
        seen += 1
    top_rows = mapplaces.top_rows(rows)
    print(
        f"generated {seen:,} places, {len(rows):,} word rows, {len(top_rows):,} top rows in {time.time() - t0:.0f}s"
    )
    t0 = time.time()
    conn = sqlite3.connect(path)
    conn.execute(f"CREATE TABLE places ({', '.join(mapplaces.COLUMNS)})")
    conn.executemany(
        f"INSERT INTO places VALUES ({', '.join('?' * len(mapplaces.COLUMNS))})", rows
    )
    conn.execute("CREATE INDEX places_word ON places (word)")
    conn.execute("CREATE INDEX places_lat ON places (lat)")
    conn.execute(f"CREATE TABLE top ({', '.join(mapplaces.TOP_COLUMNS)})")
    conn.executemany(
        f"INSERT INTO top VALUES ({', '.join('?' * len(mapplaces.TOP_COLUMNS))})",
        top_rows,
    )
    conn.execute("CREATE INDEX top_prefix ON top (prefix)")
    conn.commit()
    conn.close()
    print(f"written in {time.time() - t0:.0f}s, {os.path.getsize(path) / 1e6:.0f} MB")
    return [r[1] for r in rows[:: max(len(rows) // 5000, 1)]]


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 2_000_000
    typed = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    rng = random.Random(7)
    tmp = tempfile.mkdtemp(prefix="bench-places-")
    srv.ZIMI_DATA_DIR = tmp
    os.makedirs(os.path.join(tmp, "mapplaces"))
    names = build(mapplaces._builder.path(NAME), count, rng)
    mapplaces.ready = lambda _name: True

    by_len, every = {}, []
    for _ in range(typed):
        target = rng.choice(names)
        text = target
        if rng.random() < 0.25:  # "Springfield, IL" typed out
            region = rng.choice(REGIONS)
            text = f"{target}, {rng.choice((region[0], region[1] or region[0], region[2]))}"
        for n in sorted({1, 2, 3, 4, 5, 6, len(text)}):
            if n > len(text):
                continue
            prefix = text[:n]
            t0 = time.perf_counter()
            mapplaces.suggest(NAME, prefix)
            ms = (time.perf_counter() - t0) * 1000
            by_len.setdefault(min(n, 6), []).append(ms)
            every.append(ms)

    def row(label, ms):
        ms = sorted(ms)
        q = lambda p: ms[min(int(len(ms) * p), len(ms) - 1)]  # noqa: E731
        print(
            f"{label:>10} n={len(ms):>6}  p50 {statistics.median(ms):6.2f}  p95 {q(0.95):6.2f}  p99 {q(0.99):6.2f}  max {ms[-1]:7.2f} ms"
        )

    for n in sorted(by_len):
        row(f"{n}{'+' if n == 6 else ''} letters", by_len[n])
    row("all", every)
    import shutil

    shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
