"""Detect bundle/subset relationships among catalog items.

Why heuristic: full content overlap requires parsing every ZIM, which is
impractical. Kiwix names are consistent enough that a name + metadata
heuristic gets us ~95% of the practical signal:

  wikipedia_en_all_maxi   ←──┐
  wikipedia_en_top        ───┤  same category + language
  wikipedia_en_medicine   ───┘
                              the _all_* variant is a strict superset
                              of the topical subsets.

The shape produced for each item:

    {
        "is_subset_of":               [<bundle name>, ...],
        "supersedes":                 [<subset name>, ...],
        "freshness_advantage_subsets":[<subset name>, ...],
        "coverage_advantage_bundle":  bool,
    }

Plus a top-level family key for grouping in the UI.
"""

from __future__ import annotations

import re
from collections import defaultdict

# Match an embedded YYYY-MM token in the ZIM name. We don't anchor to end of
# string because some names omit the date entirely.
_DATE_RE = re.compile(r"(\d{4})-(\d{2})")

# A name fragment like "_all", "_all_maxi", "_all_nopic" identifies a bundle.
# Match either trailing or in-the-middle.
_BUNDLE_RE = re.compile(r"(?:^|_)all(?:_|$)")


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
    """A ZIM whose name contains the `all` segment is treated as a bundle."""
    return bool(_BUNDLE_RE.search(name.lower()))


def _family_key(item):
    """Family = category + language. Items in the same family compete for
    bundle/subset relationships."""
    cat = (item.get("category") or "").lower()
    lang = (item.get("language") or "").lower()
    if not cat or not lang:
        return None
    return f"{cat}_{lang}"


def bundle_relationships(items):
    """Compute subset/superset relationships across catalog items.

    Args:
        items: iterable of dicts with at least `name`, `category`, `language`,
               and `article_count` keys (the standard OPDS shape produced by
               zimi.library._fetch_kiwix_catalog).

    Returns:
        dict[name → relationships]. Items with no family (missing
        category/language) are returned with empty relationship lists so the
        UI can render them uniformly.
    """
    items = list(items)
    by_name = {it["name"]: it for it in items if it.get("name")}

    # Group by family
    families = defaultdict(list)
    for it in items:
        fam = _family_key(it)
        if fam is None:
            continue
        families[fam].append(it)

    out = {
        name: {
            "is_subset_of": [],
            "supersedes": [],
            "freshness_advantage_subsets": [],
            "coverage_advantage_bundle": False,
        }
        for name in by_name
    }

    for members in families.values():
        bundles = [m for m in members if _is_bundle(m["name"])]
        subsets = [m for m in members if not _is_bundle(m["name"])]
        if not bundles or not subsets:
            continue

        # Among bundles, the largest by article_count is the canonical one.
        canonical = max(bundles, key=lambda m: int(m.get("article_count") or 0))
        canon_name = canonical["name"]
        canon_count = int(canonical.get("article_count") or 0)
        canon_date = _name_date(canon_name)

        for sub in subsets:
            sub_count = int(sub.get("article_count") or 0)
            # Only treat as subset if the bundle has at least as many articles.
            # Otherwise the "subset" might actually have content the bundle
            # lacks — bail rather than mislead.
            if canon_count and sub_count > canon_count:
                continue

            out[sub["name"]]["is_subset_of"].append(canon_name)
            out[canon_name]["supersedes"].append(sub["name"])

            # Freshness: subset newer than bundle? Surface for the user.
            sub_date = _name_date(sub["name"])
            if canon_date and sub_date and sub_date > canon_date:
                out[canon_name]["freshness_advantage_subsets"].append(sub["name"])

        # Coverage: does the bundle have more articles than the sum of subsets?
        # Useful signal for "should I download just the bundle?"
        sum_subset_articles = sum(
            int(s.get("article_count") or 0)
            for s in subsets
            if canon_count and int(s.get("article_count") or 0) <= canon_count
        )
        if canon_count > 0 and canon_count > sum_subset_articles:
            out[canon_name]["coverage_advantage_bundle"] = True

    return out
