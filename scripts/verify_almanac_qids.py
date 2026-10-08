#!/usr/bin/env python3
"""Check the Almanac's curated Wikidata Q-IDs against English Wikipedia.

    python3 scripts/verify_almanac_qids.py            # audit every entry in the map
    python3 scripts/verify_almanac_qids.py --resolve "Mercury (planet)" "Sirius"

The Almanac's deep links (zimi/static/almanac-links.js) are a closed set: each
entity carries a Q-ID and the English Wikipedia title that Q-ID stands for.
Runtime is fully offline (the Q-IDs are baked in); this script is the network
step that earns them. For every `q: 'Q...', en: '...'` entry it asks the
English Wikipedia API for the page's `wikibase_item` (redirects followed) and
reports

  - a title whose Wikidata item is not the Q-ID written down,
  - a title that is a disambiguation page (never a link target),
  - a title that does not exist.

`--resolve` prints the Q-ID of each title given, for adding entries. Titles are
sent 50 at a time, as the API allows. Needs the network; nothing at runtime
does.
"""

import ast
import json
import os
import re
import sys
import urllib.parse
import urllib.request

LINKS_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "almanac-links.js",
)
API = "https://en.wikipedia.org/w/api.php"
BATCH = 50
USER_AGENT = "zimi-almanac-qid-audit/1.0 (https://github.com/epheterson/zimi)"
ENTRY = re.compile(
    r"q:\s*'(Q\d+)'\s*,\s*en:\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
)


def entries(path=LINKS_JS):
    """[(q, en title)] for every curated entry, in file order."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    return [(m.group(1), ast.literal_eval(m.group(2))) for m in ENTRY.finditer(src)]


def lookup(titles):
    """{title: {"q": Q-ID or None, "title": the article's own title, "disambig": bool,
    "missing": bool}}, redirects followed."""
    out = {}
    titles = list(dict.fromkeys(titles))
    for i in range(0, len(titles), BATCH):
        part = titles[i : i + BATCH]
        url = (
            API
            + "?"
            + urllib.parse.urlencode(
                {
                    "action": "query",
                    "format": "json",
                    "redirects": 1,
                    "prop": "pageprops",
                    "ppprop": "wikibase_item|disambiguation",
                    "titles": "|".join(part),
                }
            )
        )
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)["query"]
        # title as sent -> normalized -> redirect target -> page
        step = {t: t for t in part}
        for n in data.get("normalized", []):
            for t, cur in step.items():
                if cur == n["from"]:
                    step[t] = n["to"]
        for rd in data.get("redirects", []):
            for t, cur in step.items():
                if cur == rd["from"]:
                    step[t] = rd["to"]
        pages = {p["title"]: p for p in data["pages"].values()}
        for t in part:
            p = pages.get(step[t], {})
            props = p.get("pageprops", {})
            out[t] = {
                "q": props.get("wikibase_item"),
                "title": p.get("title", step[t]),
                "disambig": "disambiguation" in props,
                "missing": "missing" in p,
            }
    return out


def main(argv):
    if len(argv) > 1 and argv[1] == "--resolve":
        for title, r in lookup(argv[2:]).items():
            flag = (
                " (DISAMBIGUATION)"
                if r["disambig"]
                else " (MISSING)" if r["missing"] else ""
            )
            print("%s\t%s%s" % (title, r["q"], flag))
        return 0
    found = entries()
    res = lookup([en for _, en in found])
    bad = 0
    for q, en in found:
        r = res[en]
        if r["missing"] or r["disambig"] or r["q"] != q:
            bad += 1
            why = (
                "missing"
                if r["missing"]
                else "disambiguation page" if r["disambig"] else "is %s" % r["q"]
            )
            print("BAD  %-10s %-50s %s" % (q, en, why))
    print("%d entries, %d distinct titles, %d bad" % (len(found), len(res), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
