"""A ZIM renamed upstream: find its successor in the catalog.

The update check matches an installed file to the catalog by file-name prefix,
so a ZIM whose name changed (www.ready.gov_en_all became ready.gov_en_all) was
never offered its update again. The successor is found from the small table in
assets/zim-renames.json first, else by what the ZIM is: same title, language,
creator and flavour, a similar size, and exactly one candidate. No network:
the caller hands in the catalog it already holds.
"""

import json
import os
import threading

_TABLE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "zim-renames.json"
)
# Sizes within this factor of each other are the same ZIM grown or shrunk.
SIZE_RATIO = 3.0
_lock = threading.Lock()
_table = None
# new file-name prefix -> the installed file it replaces, set by the update
# check so the download that follows (whoever starts it) removes the old file.
_pending = {}


def table():
    """{old prefix: new prefix}, read once."""
    global _table
    with _lock:
        if _table is None:
            try:
                with open(_TABLE_PATH, encoding="utf-8") as f:
                    _table = dict(json.load(f).get("renames") or {})
            except (OSError, ValueError):
                _table = {}
        return _table


def successor_name(prefix):
    """The newest name `prefix` was renamed to, following a chain; `prefix`
    itself when it was never renamed."""
    t, seen = table(), {prefix}
    while prefix in t and t[prefix] not in seen:
        prefix = t[prefix]
        seen.add(prefix)
    return prefix


def old_names(prefix):
    """Every earlier name of `prefix` in the table."""
    t, out, todo = table(), [], [prefix]
    while todo:
        cur = todo.pop()
        for old, new in t.items():
            if new == cur and old not in out:
                out.append(old)
                todo.append(old)
    return out


def remember(new_prefix, installed_file):
    _pending[new_prefix] = installed_file


def replaced_by(new_prefix):
    """The installed file a download of `new_prefix` replaces, or None."""
    return _pending.get(new_prefix)


def _norm(s):
    return " ".join((s or "").casefold().split())


def find_successor(inst, index, creator_of=None):
    """The catalog entry `inst` was renamed to, or None.

    `inst`: prefix, date, flavor, title, language, size_bytes.
    `index`: [(prefixes, date, flavor, item)], the update check's catalog index.
    `creator_of`: called only when title, language and flavour already agree
    on a candidate, since it reads the installed file.
    Returns (new prefix, date, item). None when nothing matches, more than one
    thing does, or (for a match by title, not by the table) the old name is
    still in the catalog."""
    def newest(prefix):
        got = [
            (d, i)
            for prefixes, d, f, i in index
            if prefix in prefixes and f == inst["flavor"] and d > inst["date"]
        ]
        return max(got, key=lambda g: g[0], default=None)

    # The table is the word of whoever recorded the rename: it holds even while
    # Kiwix still lists the old name beside the new one.
    target = successor_name(inst["prefix"])
    if target != inst["prefix"]:
        hit = newest(target)
        return (target, hit[0], hit[1]) if hit else None
    if any(inst["prefix"] in prefixes for prefixes, _d, _f, _i in index):
        return None  # not renamed: the ordinary match handles it

    if not _norm(inst.get("title")) or not inst.get("language"):
        return None
    cands = {}
    for prefixes, d, f, item in index:
        if f != inst["flavor"] or d <= inst["date"]:
            continue
        if _norm(item.get("title")) != _norm(inst["title"]):
            continue
        if (item.get("language") or "") != inst["language"]:
            continue
        a, b = inst.get("size_bytes") or 0, item.get("size_bytes") or 0
        if a and b and not (1 / SIZE_RATIO <= b / a <= SIZE_RATIO):
            continue
        cands.setdefault(prefixes[0], []).append((d, item))
    if not cands or not creator_of:
        return None
    creator = _norm(creator_of())
    if not creator:
        return None
    cands = {
        p: v for p, v in cands.items() if _norm(v[0][1].get("author")) == creator
    }
    if len(cands) != 1:
        return None
    prefix, got = next(iter(cands.items()))
    d, item = max(got, key=lambda g: g[0])
    return prefix, d, item
