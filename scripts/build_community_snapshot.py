#!/usr/bin/env python3
"""Build the community catalog snapshot that ships inside Zimi.

Run at release time, beside build_catalog_snapshot.py:

    python3 scripts/build_community_snapshot.py

One request to Kiwix's community catalog (opds.community.library.kiwix.org); the
entries are parsed by the same code the running server uses and written to
``zimi/assets/community-snapshot.json.gz``, so a machine that has never been
online still lists them (marked Community). Rebuilding an unchanged catalog
produces identical bytes.
"""

import datetime
import gzip
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import catalog_snapshot  # noqa: E402
from zimi import library  # noqa: E402

UA = "Zimi catalog snapshot builder (+https://github.com/epheterson/Zimi)"


def main():
    req = urllib.request.Request(library.COMMUNITY_OPDS_URL, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read()
        if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
            body = gzip.decompress(body)
    items = library.parse_community(body)
    for it in items:
        it["installed"] = False  # a fact about the machine it is read on
    catalog_snapshot.write_snapshot(catalog_snapshot.COMMUNITY_PATH, items, datetime.date.today().isoformat())
    print("community snapshot: %d entries -> %s" % (len(items), catalog_snapshot.COMMUNITY_PATH))


if __name__ == "__main__":
    main()
