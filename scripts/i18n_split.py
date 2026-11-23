#!/usr/bin/env python3
"""Which of the Almanac's strings does Home need? The shared answer for the split and its guard test.

Home's files (i18n/<lang>.json) hold what the shell shows. The Almanac's own strings (prefixes alm_, tb_, ref_) live in
i18n/almanac/<lang>.json and come down with the Almanac. A key the shell's own code names stays in Home's file: a quoted
name in a non-Almanac script is either that key or the front of a family of them (alm_shower_ + the shower's name).

    python3 scripts/i18n_split.py        move the Almanac's strings out of Home's files (idempotent)
"""

import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "zimi", "static")
I18N = os.path.join(STATIC, "i18n")
ALMANAC_I18N = os.path.join(I18N, "almanac")
PREFIXES = ("alm_", "tb_", "ref_")
_NAME = re.compile(r"""["'`]((?:alm_|tb_|ref_)[A-Za-z0-9_]*)""")


def shell_sources():
    """Every script and page that is not the Almanac's own: what Home may run without the Almanac's strings."""
    paths = [
        p
        for p in glob.glob(os.path.join(STATIC, "*.js"))
        + glob.glob(os.path.join(STATIC, "*.html"))
        if not os.path.basename(p).startswith("almanac")
    ]
    paths.append(os.path.join(ROOT, "zimi", "templates", "index.html"))
    return sorted(paths)


def shell_names():
    """The quoted alm_/tb_/ref_ names in the shell's code: exact keys, or the front of a family of keys."""
    names = set()
    for p in shell_sources():
        with open(p, encoding="utf-8") as f:
            names.update(_NAME.findall(f.read()))
    assert not names & set(
        PREFIXES
    ), "a bare prefix would keep the whole Almanac in Home's file"
    return names


def is_almanac_key(key):
    return key.startswith(PREFIXES)


def home_needs(key, names):
    return any(key.startswith(n) for n in names)


def words(lang):
    """A language's whole table, Home's words and the Almanac's: what a page that has both loaded reads."""
    out = {}
    for d in (I18N, ALMANAC_I18N):
        with open(os.path.join(d, lang + ".json"), encoding="utf-8") as f:
            out.update(json.load(f))
    return out


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main():
    names = shell_names()
    for path in sorted(glob.glob(os.path.join(I18N, "*.json"))):
        lang = os.path.basename(path)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        apath = os.path.join(ALMANAC_I18N, lang)
        aldata = (
            json.load(open(apath, encoding="utf-8")) if os.path.exists(apath) else {}
        )
        moved = {
            k: v
            for k, v in data.items()
            if is_almanac_key(k) and not home_needs(k, names)
        }
        write(path, {k: v for k, v in data.items() if k not in moved})
        write(apath, {**aldata, **moved})
        print(lang, "moved", len(moved))


if __name__ == "__main__":
    main()
