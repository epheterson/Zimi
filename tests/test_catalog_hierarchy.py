"""Tests for OPDS catalog subset/superset detection."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.catalog_hierarchy import _is_bundle, bundle_relationships  # noqa: E402


def _item(name, category, language, article_count=1000):
    return {
        "name": name,
        "category": category,
        "language": language,
        "article_count": article_count,
    }


# ────────────────────────────────────────────────────────────────────────────
# Subset / superset detection
# ────────────────────────────────────────────────────────────────────────────


def test_wikipedia_subsets_recognized():
    items = [
        _item("wikipedia_en_all_maxi_2024-04", "wikipedia", "en", 6_000_000),
        _item("wikipedia_en_top_2024-04", "wikipedia", "en", 100_000),
        _item("wikipedia_en_medicine_2024-04", "wikipedia", "en", 50_000),
    ]
    rels = bundle_relationships(items)
    assert rels["wikipedia_en_top_2024-04"]["is_subset_of"] == [
        "wikipedia_en_all_maxi_2024-04"
    ]
    assert rels["wikipedia_en_medicine_2024-04"]["is_subset_of"] == [
        "wikipedia_en_all_maxi_2024-04"
    ]
    assert set(rels["wikipedia_en_all_maxi_2024-04"]["supersedes"]) == {
        "wikipedia_en_top_2024-04",
        "wikipedia_en_medicine_2024-04",
    }


def test_orphan_zim_has_empty_relationships():
    items = [_item("appropedia_2024-04", "other", "en", 30_000)]
    rels = bundle_relationships(items)
    assert rels["appropedia_2024-04"] == {
        "is_subset_of": [],
        "supersedes": [],
        "freshness_advantage_subsets": [],
        "coverage_advantage_bundle": False,
    }


def test_no_cross_language_false_positive():
    items = [
        _item("wikipedia_en_all_maxi", "wikipedia", "en", 6_000_000),
        _item("wikipedia_fr_top", "wikipedia", "fr", 80_000),
    ]
    rels = bundle_relationships(items)
    assert rels["wikipedia_fr_top"]["is_subset_of"] == []
    assert rels["wikipedia_en_all_maxi"]["supersedes"] == []


def test_supersedes_inverse_of_subset():
    items = [
        _item("ted_en_all_2024-01", "ted", "en", 5_000),
        _item("ted_en_business_2024-01", "ted", "en", 1_000),
    ]
    rels = bundle_relationships(items)
    assert "ted_en_business_2024-01" in rels["ted_en_all_2024-01"]["supersedes"]
    assert "ted_en_all_2024-01" in rels["ted_en_business_2024-01"]["is_subset_of"]


def test_subset_with_more_articles_is_not_subset():
    """If the 'subset' has more articles than the 'bundle', skip it — the
    relationship would mislead users."""
    items = [
        _item("wikipedia_en_all_2020-01", "wikipedia", "en", 100),  # very old, small
        _item("wikipedia_en_top_2024-04", "wikipedia", "en", 200),  # big subset
    ]
    rels = bundle_relationships(items)
    assert rels["wikipedia_en_top_2024-04"]["is_subset_of"] == []


def test_no_self_subset():
    items = [_item("wikipedia_en_all_maxi", "wikipedia", "en", 6_000_000)]
    rels = bundle_relationships(items)
    assert rels["wikipedia_en_all_maxi"]["is_subset_of"] == []
    assert rels["wikipedia_en_all_maxi"]["supersedes"] == []


# ────────────────────────────────────────────────────────────────────────────
# Freshness signal
# ────────────────────────────────────────────────────────────────────────────


def test_ted_freshness_advantage_flagged():
    """Old bundle, newer subsets — flag for the user."""
    items = [
        _item("ted_en_all_2022-01", "ted", "en", 5_000),
        _item("ted_en_business_2024-04", "ted", "en", 1_500),
    ]
    rels = bundle_relationships(items)
    assert (
        "ted_en_business_2024-04"
        in rels["ted_en_all_2022-01"]["freshness_advantage_subsets"]
    )


def test_no_freshness_when_bundle_is_current():
    items = [
        _item("ted_en_all_2024-04", "ted", "en", 5_000),
        _item("ted_en_business_2024-01", "ted", "en", 1_500),
    ]
    rels = bundle_relationships(items)
    assert rels["ted_en_all_2024-04"]["freshness_advantage_subsets"] == []


def test_freshness_skipped_without_dates():
    items = [
        _item("ted_en_all", "ted", "en", 5_000),
        _item("ted_en_business", "ted", "en", 1_500),
    ]
    rels = bundle_relationships(items)
    assert rels["ted_en_all"]["freshness_advantage_subsets"] == []


# ────────────────────────────────────────────────────────────────────────────
# Coverage signal
# ────────────────────────────────────────────────────────────────────────────


def test_coverage_advantage_bundle_when_bundle_larger():
    items = [
        _item("wikipedia_en_all_maxi", "wikipedia", "en", 6_000_000),
        _item("wikipedia_en_top", "wikipedia", "en", 100_000),
        _item("wikipedia_en_medicine", "wikipedia", "en", 50_000),
    ]
    rels = bundle_relationships(items)
    assert rels["wikipedia_en_all_maxi"]["coverage_advantage_bundle"] is True


def test_no_coverage_advantage_when_subsets_sum_more():
    """If subsets together contain more articles than the bundle, the bundle
    isn't a strict superset — don't claim coverage advantage."""
    items = [
        _item("ted_en_all", "ted", "en", 1_000),
        _item("ted_en_business", "ted", "en", 800),
        _item("ted_en_technology", "ted", "en", 700),
    ]
    rels = bundle_relationships(items)
    # Subsets sum to 1500 > 1000 bundle. But each subset is < bundle so they
    # still count as subsets; the bundle just doesn't get a coverage win.
    # subsets that exceed the bundle are dropped from the sum, so this case
    # demonstrates that coverage_advantage_bundle stays False.
    assert rels["ted_en_all"]["coverage_advantage_bundle"] is False


# ────────────────────────────────────────────────────────────────────────────
# Robustness
# ────────────────────────────────────────────────────────────────────────────


def test_handles_missing_article_count():
    items = [
        _item("wikipedia_en_all_maxi", "wikipedia", "en"),
        _item("wikipedia_en_top", "wikipedia", "en"),
    ]
    items[0]["article_count"] = None  # simulate OPDS missing field
    rels = bundle_relationships(items)
    # Missing count → can't decide subset relationship, falls through cleanly
    assert isinstance(rels["wikipedia_en_top"]["is_subset_of"], list)


def test_handles_missing_category_or_language():
    items = [
        _item("wikipedia_en_all_maxi", "", "en", 1_000),
        _item("wikipedia_en_top", "wikipedia", "", 100),
    ]
    rels = bundle_relationships(items)
    # Items without family produce empty relationship records but don't crash.
    assert rels["wikipedia_en_all_maxi"]["supersedes"] == []
    assert rels["wikipedia_en_top"]["is_subset_of"] == []


def test_empty_input():
    assert bundle_relationships([]) == {}


def test_devdocs_all_topic_not_treated_as_bundle():
    """devdocs_en_all_cheatography means full Cheatography collection, not all devdocs.
    It must NOT be treated as a bundle covering other devdocs like angular.js."""
    items = [
        _item("devdocs_en_all_cheatography", "devdocs", "en", 5_000),
        _item("devdocs_en_all_angular.js", "devdocs", "en", 3_000),
    ]
    rels = bundle_relationships(items)
    assert rels["devdocs_en_all_angular.js"]["is_subset_of"] == []
    assert rels["devdocs_en_all_cheatography"]["supersedes"] == []


# Real names sampled from library.kiwix.org with synthetic edge cases mixed in.
# Update this fixture when adding new variants — single source of truth for the
# bundle-detection contract.
_BUNDLE_FIXTURE = [
    # Universal bundles — must be True
    ("wikipedia_en_all", True),
    ("wikipedia_en_all_maxi", True),
    ("wikipedia_en_all_nopic", True),
    ("wikipedia_en_all_mini", True),
    ("wikipedia_en_all_nodet", True),
    ("wikipedia_en_all_maxi_2024-04", True),
    ("wikipedia_simple_all_maxi", True),
    ("wiktionary_fr_all_nopic", True),
    ("wikivoyage_en_all_maxi", True),
    ("wikiquote_en_all_nopic", True),
    ("ted_en_all", True),
    ("ted_en_all_2024-01", True),
    ("stackoverflow_en_all", True),
    ("freecodecamp_en_all_2025-01", True),
    ("appropedia_en_all_2024-04", True),
    # Topic-specific (NOT bundles) — false-positive guard
    ("devdocs_en_all_angular.js", False),
    ("devdocs_en_all_cheatography", False),
    ("devdocs_en_all_react", False),
    ("devdocs_en_all_python", False),
    (
        "stackexchange_en_3dprinting.com_en_all",
        True,
    ),  # site-level bundle, leaf is `_all`
    # Topical subsets — false negative guard
    ("wikipedia_en_top", False),
    ("wikipedia_en_medicine", False),
    ("wikipedia_en_wp1-0.7", False),
    ("ted_en_business", False),
    ("ted_en_technology", False),
    ("wikipedia_fr_top_2024-04", False),
    # Substring traps — `all` appears but not as its own token
    ("wikipedia_en_smallville", False),
    ("wikipedia_en_dallas", False),
    ("wikipedia_en_tallinn", False),
    # Standalone non-bundle entries (no _all token)
    ("gutenberg_en_all", True),
    ("gutenberg_fr_2024-04", False),
    ("zimit_en_kiwix.org_2024-04", False),
    ("phet_en", False),
    ("vikidia_fr_all", True),
]


def test_bundle_detection_fixture():
    """Single source of truth for the _is_bundle contract.
    Add new Kiwix naming patterns here when they show up in the wild."""
    failures = []
    for name, expected in _BUNDLE_FIXTURE:
        got = _is_bundle(name)
        if got != expected:
            failures.append(f"  {name!r}: expected {expected}, got {got}")
    assert not failures, "bundle detection mismatches:\n" + "\n".join(failures)
