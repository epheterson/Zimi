#!/usr/bin/env python3
"""Refresh the launch history that ships with Zimi, before a release.

    python3 scripts/build_launches.py            # download from GCAT, write the snapshot
    python3 scripts/build_launches.py --src DIR  # read launch.tsv sites.tsv lp.tsv psatcat.tsv satcat.tsv from DIR

Every orbital launch attempt in Jonathan McDowell's GCAT (General Catalog of
Artificial Space Objects, https://planet4589.org/space/gcat/, CC-BY 4.0): when
(UTC), from which pad (with coordinates), on what, carrying what, how it went,
the orbit it aimed for, and for batches the first payload's separation time and
early orbit. Writes zimi/assets/launches-snapshot.json.gz, which zimi/launches.py
serves at /almanac-launches. The parsing is zimi/launches.py's, so a live
refresh and this snapshot agree.

Sources (fetched on the date in the snapshot's ``gcat`` field):

    https://planet4589.org/space/gcat/tsv/launch/launch.tsv   the launches
    https://planet4589.org/space/gcat/tsv/tables/sites.tsv    launch sites
    https://planet4589.org/space/gcat/tsv/tables/lp.tsv       launch pads
    https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv     payload names, per launch
    https://planet4589.org/space/gcat/tsv/cat/satcat.tsv      separation time and the first orbit after it

Credit: McDowell, J. C., GCAT, CC-BY 4.0 (zimi/static/earth/SOURCES.txt).
"""

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from zimi import launches  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--src", help="a folder holding the five GCAT files, named as in the URLs above"
    )
    args = ap.parse_args()
    if args.src:
        src = {}
        for key, rel in launches.SOURCE_FILES.items():
            with open(
                os.path.join(args.src, os.path.basename(rel)),
                encoding="utf-8",
                errors="replace",
            ) as f:
                src[key] = f.read()
        payload = launches.build(src)
    else:
        payload = launches.fetch_live()
    launches.write_snapshot(launches.SNAPSHOT_PATH, payload)
    print(
        "%d launches, %d vehicles, %d pads -> %s (%d bytes)"
        % (
            len(payload["l"]),
            len(payload["veh"]),
            len(payload["pads"]),
            launches.SNAPSHOT_PATH,
            os.path.getsize(launches.SNAPSHOT_PATH),
        )
    )


if __name__ == "__main__":
    sys.exit(main())
