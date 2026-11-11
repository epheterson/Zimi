#!/usr/bin/env python3
"""Git merge driver for flat JSON string tables (zimi/static/i18n/*.json): three-way by key.

    json_merge3.py BASE OURS THEIRS   (git's %O %A %B; the result is written to OURS)

Keys either side added are kept (ours in place, theirs' new ones appended in their order); a key one side changed
and the other did not takes the change; a key both sides changed differently, or one deleted while the other
changed, is a real conflict: the driver leaves OURS alone and exits 1 so git reports it.
"""

import json
import sys


def _load(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return json.loads(text) if text.strip() else {}


def merge(base, ours, theirs):
    """The merged table, or None when a key truly conflicts."""
    out = {}
    for k in list(ours) + [k for k in theirs if k not in ours]:
        b, o, t = base.get(k), ours.get(k), theirs.get(k)
        if o == t or t == b:
            v = o
        elif o == b:
            v = t
        else:
            return None
        if v is not None:
            out[k] = v
    return out


def main(argv):
    base, ours, theirs = (_load(p) for p in argv[1:4])
    merged = merge(base, ours, theirs)
    if merged is None:
        return 1
    with open(argv[2], "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
