"""Every locale file must carry exactly the same key set as en.json.

A missing key renders as the raw key name in that language (the bug class
behind issue #25); an extra key is dead weight. This kept 900+ keys x 10
locales in lockstep by hand until now — CI enforces it instead.
"""

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

I18N_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "i18n",
)


def test_all_locales_share_the_en_key_set():
    with open(os.path.join(I18N_DIR, "en.json")) as f:
        en_keys = set(json.load(f))
    assert en_keys, "en.json is empty?"
    problems = []
    for path in sorted(glob.glob(os.path.join(I18N_DIR, "*.json"))):
        lang = os.path.basename(path)
        with open(path) as f:
            keys = set(json.load(f))
        missing = en_keys - keys
        extra = keys - en_keys
        if missing:
            problems.append(f"{lang}: missing {sorted(missing)[:5]}")
        if extra:
            problems.append(f"{lang}: extra {sorted(extra)[:5]}")
    assert not problems, "; ".join(problems)


def test_no_empty_values():
    for path in sorted(glob.glob(os.path.join(I18N_DIR, "*.json"))):
        with open(path) as f:
            data = json.load(f)
        empty = [k for k, v in data.items() if not str(v).strip()]
        assert not empty, f"{os.path.basename(path)}: empty values for {empty[:5]}"
