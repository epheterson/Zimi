"""Tests for the search-counter and top-searches stats."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.http as http  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_usage():
    with http._usage_lock:
        http._usage_stats["searches"] = 0
        http._usage_stats["article_reads"] = 0
        http._usage_stats["by_zim"].clear()
        http._usage_stats["by_query"].clear()
    yield


# ────────────────────────────────────────────────────────────────────────────
# Counter behaviour
# ────────────────────────────────────────────────────────────────────────────


def test_search_increments_total():
    http._record_usage("search", query="paris")
    http._record_usage("search", query="paris")
    stats = http._get_usage_stats()
    assert stats["searches"] == 2


def test_top_searches_sorted_by_count():
    for q in ["paris", "paris", "paris", "berlin", "berlin", "tokyo"]:
        http._record_usage("search", query=q)
    stats = http._get_usage_stats()
    queries = [item["query"] for item in stats["top_searches"]]
    counts = [item["count"] for item in stats["top_searches"]]
    assert queries == ["paris", "berlin", "tokyo"]
    assert counts == [3, 2, 1]


def test_top_searches_capped_at_10():
    for i in range(15):
        for _ in range(i + 1):
            http._record_usage("search", query=f"q{i}")
    stats = http._get_usage_stats()
    assert len(stats["top_searches"]) == 10
    # Highest count entry comes first
    assert stats["top_searches"][0]["query"] == "q14"
    assert stats["top_searches"][0]["count"] == 15


def test_query_normalization_buckets_variants():
    """Whitespace and case variants count as the same query."""
    http._record_usage("search", query="Paris")
    http._record_usage("search", query="  paris  ")
    http._record_usage("search", query="PARIS")
    stats = http._get_usage_stats()
    assert stats["top_searches"] == [{"query": "paris", "count": 3}]


def test_empty_query_not_tracked():
    http._record_usage("search", query="")
    http._record_usage("search", query=None)
    http._record_usage("search", query="   ")
    stats = http._get_usage_stats()
    # Total searches still increments, but no query buckets
    assert stats["searches"] == 3
    assert stats["top_searches"] == []


def test_query_counter_capped_at_max(monkeypatch):
    """Once the cap is hit we stop adding new keys but keep counting existing ones."""
    monkeypatch.setattr(http, "_SEARCH_QUERY_CAP", 5)
    for q in ["a", "b", "c", "d", "e"]:
        http._record_usage("search", query=q)
    # Cap hit; new keys ignored.
    http._record_usage("search", query="f")
    http._record_usage("search", query="a")  # existing key still counts
    stats = http._get_usage_stats()
    assert stats["tracked_queries"] == 5
    queries = {item["query"] for item in stats["top_searches"]}
    assert "f" not in queries
    a_count = next(
        item["count"] for item in stats["top_searches"] if item["query"] == "a"
    )
    assert a_count == 2
