"""Write zimi/assets/whatsnew.json from CHANGELOG.md: per release, the highlight lines about Zimi's own
ZIMs (the games, the Almanac). The CHANGELOG is not in the package; this small view of it is, so the
Games and Almanac dots can say what a new release changed. tests/test_whatsnew.py fails when the two differ.

    python scripts/whatsnew.py          # rewrite the file
    python scripts/whatsnew.py --check  # exit 1 when it is out of date
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
OUT = os.path.join(ROOT, "zimi", "assets", "whatsnew.json")

# Which own ZIM a highlight's label is about. A label is about the first one it fits, so Sky Detective (a game that
# studies the Almanac's sky) is not the Almanac's.
OWN_LABELS = {
    "zimi_games": ("games", "zimcity", "daily games", "sky detective"),
    "zimi_almanac": ("almanac", "tides", "sky"),
}
_RELEASE = re.compile(r"^## \[(\d+\.\d+\.\d+)\]")
# "- **Label:** text", or the plain "- Label: text" the 1.15.0 highlights are written in.
_HIGHLIGHT = re.compile(r"^- (?:\*\*([^*]+?):\*\*|([^*:]{1,40}):)\s*(.+)$")


def build(text):
    out, version, in_highlights = {}, None, False
    for line in text.splitlines():
        m = _RELEASE.match(line)
        if m:
            version, in_highlights = m.group(1), False
            continue
        if line.startswith("### "):
            in_highlights = line.strip() == "### Highlights"
            continue
        h = _HIGHLIGHT.match(line) if version and in_highlights else None
        if not h:
            continue
        label, rest = (h.group(1) or h.group(2)).strip(), h.group(3).strip()
        own = next(
            (
                o
                for o, words in OWN_LABELS.items()
                if any(w in label.lower() for w in words)
            ),
            None,
        )
        if own:
            out.setdefault(version, {}).setdefault(own, []).append(label + ": " + rest)
    return out


def render():
    with open(CHANGELOG, encoding="utf-8") as f:
        data = build(f.read())
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


if __name__ == "__main__":
    want = render()
    if sys.argv[1:] == ["--check"]:
        try:
            with open(OUT, encoding="utf-8") as f:
                have = f.read()
        except OSError:
            have = ""
        sys.exit(0 if have == want else 1)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(want)
