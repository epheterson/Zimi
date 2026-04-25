"""Tests for OPDS catalog subset/superset detection."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.catalog_hierarchy import bundle_relationships  # noqa: E402


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
