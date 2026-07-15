"""Detect bundle/subset relationships among catalog items.

Full content overlap requires parsing every ZIM, which is impractical. The
heuristic uses two signals from the OPDS catalog: shared `category`+`language`
("family"), and the convention that `_all` near the end of a name marks a
universal bundle:

  wikipedia_en_all_maxi   ←──┐
  wikipedia_en_top        ───┤  same category + language
  wikipedia_en_medicine   ───┘
                              the _all_* variant is a strict superset
                              of the topical subsets.

The `_all` token is overloaded across categories. For Wikipedia/TED/StackExchange
it means "covers everything in the family"; for devdocs it means "full-quality
variant of one specific topic" (`devdocs_en_all_cheatography` is NOT a superset
of `devdocs_en_all_angular.js`). `_is_bundle` distinguishes the two cases by
requiring tokens after `_all` to be display variants or dates, never topic names.

Note: when a family contains ONLY bundle-named items (e.g., StackExchange where
every site is `<site>.com_en_all`), no relationships emit. That's intentional —
no real superset exists in that catalog shape.

Per-item output:

    {
        "is_subset_of":               [<bundle name>, ...],
        "supersedes":                 [<subset name>, ...],
        "freshness_advantage_subsets":[<subset name>, ...],
        "coverage_advantage_bundle":  bool,
    }
"""

from __future__ import annotations

import re
from collections import defaultdict

_DATE_RE = re.compile(r"(\d{4})-(\d{2})")
_DATE_TOKEN_RE = re.compile(r"^\d{4}-\d{2}$")
# Matches `_all` (or `all` at start) optionally followed by display-only suffix.
# Must end at end-of-string so topic names after `_all_` (e.g. `_all_cheatography`)
# are not mistaken for universal bundles.
_BUNDLE_RE = re.compile(r"(?:^|_)all(_.*)?$")
# Quality/display suffixes that may appear after `_all` in a true universal bundle.
# `nodet` = no-details (intro-only articles); the rest are size/media tradeoffs.
_DISPLAY_VARIANTS = frozenset({"maxi", "mini", "nopic", "novid", "nodet"})


def _name_date(name):
    """Return (year, month) tuple if the name has a YYYY-MM token; else None."""
    m = _DATE_RE.search(name)
    if not m:
        return None
    try:
        return int(m.group(1)), int(m.group(2))
    except (ValueError, TypeError):
        return None


def _is_bundle(name):
    m = _BUNDLE_RE.search(name.lower())
    if not m:
        return False
    rest = m.group(1)  # None if name ends with `_all`, otherwise `_maxi` etc.
    if rest is None:
        return True
    parts = [p for p in rest[1:].split("_") if p]
    return all(p in _DISPLAY_VARIANTS or _DATE_TOKEN_RE.match(p) for p in parts)


def _family_key(item):
    cat = (item.get("category") or "").lower()
    lang = (item.get("language") or "").lower()
    if not cat or not lang:
        return None
    return f"{cat}_{lang}"


def _article_count(item):
    return int(item.get("article_count") or 0)


def _empty_record():
    return {
        "is_subset_of": [],
        "supersedes": [],
        "freshness_advantage_subsets": [],
        "coverage_advantage_bundle": False,
    }


def bundle_relationships(items):
    """Compute subset/superset relationships across catalog items.

    Args:
        items: iterable of dicts with at least `name`, `category`, `language`,
               and `article_count` keys (the standard OPDS shape produced by
               zimi.library._fetch_kiwix_catalog).

    Returns:
        dict[name → relationships]. Items with no family (missing
        category/language) get an empty record so the UI can render uniformly.
    """
    # Dedupe by name — Kiwix can return the same logical name multiple times
    # for different file variants (maxi/nopic/etc). Pick the entry with the
    # highest article_count as canonical.
    by_name = {}
    for it in items:
        name = it.get("name")
        if not name:
            continue
        if name not in by_name or _article_count(it) > _article_count(by_name[name]):
            by_name[name] = it

    families = defaultdict(list)
    for it in by_name.values():
        fam = _family_key(it)
        if fam:
            families[fam].append(it)

    out = {name: _empty_record() for name in by_name}

    for members in families.values():
        bundles = [m for m in members if _is_bundle(m["name"])]
        subsets = [m for m in members if not _is_bundle(m["name"])]
        if not bundles or not subsets:
            continue

        canonical = max(bundles, key=_article_count)
        canon_name = canonical["name"]
        canon_count = _article_count(canonical)
        canon_date = _name_date(canon_name)

        # Skip subsets whose article count exceeds the canonical bundle's —
        # claiming containment when the "subset" is actually larger would
        # mislead the user.
        valid_subsets = [
            s for s in subsets if not canon_count or _article_count(s) <= canon_count
        ]

        for sub in valid_subsets:
            out[sub["name"]]["is_subset_of"].append(canon_name)
            out[canon_name]["supersedes"].append(sub["name"])
            sub_date = _name_date(sub["name"])
            if canon_date and sub_date and sub_date > canon_date:
                out[canon_name]["freshness_advantage_subsets"].append(sub["name"])

        sum_subset_articles = sum(_article_count(s) for s in valid_subsets)
        if canon_count > 0 and canon_count > sum_subset_articles:
            out[canon_name]["coverage_advantage_bundle"] = True

    return out
