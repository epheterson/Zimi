#!/usr/bin/env python3
"""Check ZimiGames' Q-IDs against English Wikipedia.

    python3 scripts/verify_games_qids.py

Each row of zimi/builtin/games/games.json that stands for a game with an
encyclopedia article carries `qid` and `wiki` (the English title). The About
link and the "learn more" links resolve through the Q-ID, so a wrong one opens
the wrong article. For every row this asks the English Wikipedia API for the
title's `wikibase_item` (redirects followed) and reports a title that is
missing, a disambiguation page, or whose item is not the Q-ID written down.
Same lookup as verify_almanac_qids.py. Needs the network; nothing at runtime does.
"""

import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_almanac_qids import BATCH, USER_AGENT, lookup  # noqa: E402

GAMES_JSON = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
    "games.json",
)


def entries(path=GAMES_JSON):
    """[(q, en title, page)] for every row that has an article."""
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    return [
        (r["qid"], r["wiki"], r["path"]) for r in rows if r.get("qid") and r.get("wiki")
    ]


WIKIDATA = "https://www.wikidata.org/w/api.php"


def enwiki_titles(qids):
    """{Q-ID: the English Wikipedia title the item's sitelink names}, 50 at a time."""
    out = {}
    qids = list(dict.fromkeys(qids))
    for i in range(0, len(qids), BATCH):
        url = WIKIDATA + "?" + urllib.parse.urlencode(
            {
                "action": "wbgetentities",
                "format": "json",
                "props": "sitelinks",
                "sitefilter": "enwiki",
                "ids": "|".join(qids[i : i + BATCH]),
            }
        )
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)["entities"]
        for q, ent in data.items():
            link = ent.get("sitelinks", {}).get("enwiki")
            if link:
                out[q] = link["title"]
    return out


def audit(found, res, sitelinks=lambda qids: {}):
    """[(q, title, page, why)] for each entry whose article is not its Q-ID.

    A title that is a redirect to another item's article still fits when the
    Q-ID's own English sitelink is that very title (Wikidata files a game under
    the redirect), so only the rest are reported."""
    bad = []
    mismatched = [q for q, en, _ in found if not (res[en]["missing"] or res[en]["disambig"]) and res[en]["q"] != q]
    own = sitelinks(mismatched) if mismatched else {}
    for q, en, page in found:
        r = res[en]
        if r["missing"]:
            bad.append((q, en, page, "missing"))
        elif r["disambig"]:
            bad.append((q, en, page, "disambiguation page"))
        elif r["q"] != q and own.get(q) != en:
            bad.append((q, en, page, "is %s" % r["q"]))
    return bad


def main():
    found = entries()
    bad = audit(found, lookup([en for _, en, _ in found]), enwiki_titles)
    for q, en, page, why in bad:
        print("BAD  %-10s %-45s %-28s %s" % (q, en, page, why))
    print("%d games, %d bad" % (len(found), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
