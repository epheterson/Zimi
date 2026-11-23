#!/usr/bin/env python3
"""Add (or refresh) only the probe missions in zimi/static/earth/missions-v1.json, leaving the Apollo 11 tables as they are (those take minutes to rebuild).

python3 scripts/build_missions_probes.py [voyager1,voyager2,...]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_missions as bm  # noqa: E402

if __name__ == "__main__":
    keys = (
        sys.argv[1] if len(sys.argv) > 1 else "voyager1,voyager2,newhorizons,cassini"
    ).split(",")
    data = json.load(open(bm.OUT))
    for k in keys:
        data["missions"][k] = bm.build_probe(k)
        print(k, len(json.dumps(data["missions"][k])), "bytes")
    with open(bm.OUT, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
