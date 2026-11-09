#!/usr/bin/env python3
"""Write tests/shard_weights.json: how long each test module took, so the CI shards are balanced by time.

    python3 scripts/shard_weights.py junit-1.xml junit-2.xml ...    # CI uploads one per browser shard
    python3 scripts/shard_weights.py --from-log run.txt             # a `pytest --durations=0` log instead

The split (tests/conftest.py, --shard I/N) deals the heaviest module to the lightest shard; with these
seconds it is balanced by what the tests cost, not by how big their files are. A module missing here is
weighed by its size, so the file never has to be complete. Refresh it when a shard run is much longer
than its siblings (the job summary prints each shard's time).
"""

import collections
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "tests",
    "shard_weights.json",
)
#: Modules whose browser is WebKit, which CI does not install: they are collected there and skip at once, so they
#: weigh nothing in a CI shard however long they take on a Mac.
SKIPPED_IN_CI = ("test_games_final_fixes.py", "test_games_start_banner_browser.py")
_DURATION = re.compile(r"^\s*([\d.]+)s (?:call|setup|teardown)\s+tests/([\w]+\.py)::")


def from_junit(paths):
    total = collections.Counter()
    for path in paths:
        for case in ET.parse(path).iter("testcase"):
            module = case.get("classname", "").split(".")
            name = next((m for m in module if m.startswith("test_")), None)
            if name:
                total[name + ".py"] += float(case.get("time") or 0)
    return total


def from_log(path):
    total = collections.Counter()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = _DURATION.match(line)
            if m:
                total[m.group(2)] += float(m.group(1))
    return total


def main(argv):
    if len(argv) == 2 and argv[0] == "--from-log":
        total = from_log(argv[1])
    elif argv and not argv[0].startswith("-"):
        total = from_junit(argv)
    else:
        print(__doc__)
        return 2
    weights = {name: round(sec, 1) for name, sec in sorted(total.items()) if sec >= 0.1}
    weights.update({name: 1.0 for name in SKIPPED_IN_CI})
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(weights, f, indent=0, sort_keys=True)
        f.write("\n")
    print(
        "%d modules, %.0f s in all -> %s" % (len(weights), sum(weights.values()), OUT)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
