"""No two scripts that share the Almanac's page declare the same top-level function or var.

Every file loads into one global scope, so the second to load silently replaces the first (two lanes once
both declared _asFrame, and a landing-site visit threw every frame). The scan reads each file's own top
level (column zero), skipping comments and strings that merely start a line.
"""

import glob
import os
import re
from collections import defaultdict

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")
#: Scripts that run in the same page as the Almanac.
PAGE_FILES = ["almanac*.js", "app.js", "zone-places.js"]
DECL = re.compile(r"^(?:async\s+)?(?:function\s*\*?|var|let|const)\s+([A-Za-z_$][\w$]*)", re.M)
#: Names declared twice on purpose: almanac.js replaces app.js's stub of closeAlmanac when it loads.
ALLOWED = {"closeAlmanac"}


def _strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", text)


def duplicates():
    seen = defaultdict(set)
    for pattern in PAGE_FILES:
        for path in sorted(glob.glob(os.path.join(STATIC, pattern))):
            with open(path, encoding="utf-8") as f:
                text = _strip_comments(f.read())
            for name in DECL.findall(text):
                seen[name].add(os.path.basename(path))
    return {n: sorted(f) for n, f in seen.items() if len(f) > 1 and n not in ALLOWED}


def test_no_global_is_declared_in_two_files():
    dups = duplicates()
    assert not dups, "declared in more than one file (the later one wins):\n" + "\n".join(
        "  %s: %s" % (n, ", ".join(f)) for n, f in sorted(dups.items())
    )
