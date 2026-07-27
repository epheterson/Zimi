#!/usr/bin/env python3
"""Verify the almanac deep-link map against a live Zimi library.

The almanac's curated entity map (zimi/static/almanac-links.js) carries, for
every linkable entity, a Wikidata Q-ID and its canonical English Wikipedia
article title. A title/Q-ID is only useful if it resolves to a real article in
the installed library. Against a full English Wikipedia ZIM that is the ground
truth this repo cannot embed (the CI fixture has ~100 articles), so this script
lets an operator point at a real install and list the misses.

Usage:
    scripts/verify_almanac_links.py [BASE_URL]

    BASE_URL defaults to the local server. Point it at any Zimi install with a
    full encyclopedia ZIM; a small ZIM will report misses that aren't real.

It POSTs the whole curated Q-ID + title set to /almanac-links in one batch
(<= ALMANAC_QID_BATCH_MAX = 400) and prints, per entity:
    HIT   <key>  ->  <resolved article title>   (flagged if the resolved title
                                                  differs from the curated one)
    MISS  <key>  Q<id>  "<curated title>"

Read-only. Exit code 0 if every curated entity resolved, 1 otherwise.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

LINKS_JS = (
    Path(__file__).resolve().parent.parent / "zimi" / "static" / "almanac-links.js"
)
DEFAULT_BASE = "http://localhost:8899"
BATCH_MAX = 400

# Matches:  'key': { q: 'Q123', en: 'Article Title' }  (key may be namespaced)
ENTRY_RE = re.compile(
    r"""['"]([a-z0-9_:]+)['"]\s*:\s*\{\s*q:\s*['"](Q\d+)['"]\s*,\s*en:\s*(['"])(.*?)\3""",
    re.IGNORECASE,
)


def parse_map(path):
    """Return [(key, qid, en_title)] parsed from almanac-links.js."""
    text = path.read_text(encoding="utf-8")
    # Decode the \uXXXX escapes the JS source uses for non-ASCII titles.
    entries = []
    for key, qid, _quote, en in ENTRY_RE.findall(text):
        en = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), en)
        en = en.replace("\\'", "'").replace('\\"', '"')
        entries.append((key, qid, en))
    return entries


def resolve(base, qids, titles):
    """POST one batch to /almanac-links; return the {qid: {...}} links map."""
    payload = json.dumps({"qids": qids, "langs": ["en"], "titles": titles}).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/almanac-links",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read()).get("links", {})


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE
    entries = parse_map(LINKS_JS)
    if not entries:
        print("no entries parsed from", LINKS_JS, file=sys.stderr)
        return 2

    # Dedupe by Q-ID (the batch is keyed by Q-ID), first title wins — same as
    # the client's _qidTitles().
    qids, titles, qid_first_key = [], {}, {}
    for key, qid, en in entries:
        if qid not in titles:
            titles[qid] = en
            qids.append(qid)
            qid_first_key[qid] = key
    if len(qids) > BATCH_MAX:
        print(
            f"warning: {len(qids)} Q-IDs exceeds batch max {BATCH_MAX}", file=sys.stderr
        )

    print(
        f"Verifying {len(entries)} entities ({len(qids)} unique Q-IDs) against {base}\n"
    )
    try:
        links = resolve(base, qids, titles)
    except Exception as e:  # noqa: BLE001 - operator tool, surface the reason
        print(f"request failed: {e}", file=sys.stderr)
        return 2

    hits = misses = mismatches = 0
    miss_lines, mismatch_lines = [], []
    for qid in qids:
        key = qid_first_key[qid]
        curated = titles[qid]
        hit = links.get(qid)
        if hit:
            hits += 1
            got = hit.get("title", "")
            # A resolved title that differs from the curated one usually just
            # means a redirect (fine) but can also mean a wrong Q-ID landed on
            # the wrong article — worth an eyeball.
            norm = lambda s: re.sub(r"[^a-z0-9]+", "", s.lower())
            if norm(got) != norm(curated):
                mismatches += 1
                mismatch_lines.append(
                    f"  ~ {key:<28} {qid:<10} curated={curated!r} -> got={got!r}"
                )
        else:
            misses += 1
            miss_lines.append(f"  MISS {key:<28} {qid:<10} {curated!r}")

    if miss_lines:
        print("MISSES (no article resolved — will render as plain text):")
        print("\n".join(miss_lines))
        print()
    if mismatch_lines:
        print("TITLE MISMATCHES (resolved, but article differs from curated — verify):")
        print("\n".join(mismatch_lines))
        print()
    print(
        f"Summary: {hits} hit / {misses} miss / {mismatches} title-mismatch  of {len(qids)} Q-IDs"
    )
    return 0 if misses == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
