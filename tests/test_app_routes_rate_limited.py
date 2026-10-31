"""Every app route is rate limited, not only its bare path.

The limiter matched /exchange and /reddot exactly, and their subpaths
(/exchange/question, /reddot/post, ...) answered without limit: 75 of 75
requests got 200 on the NAS test copy.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import http  # noqa: E402


@pytest.mark.parametrize(
    "path",
    ["/exchange", "/exchange/question", "/exchange/tags", "/reddot", "/reddot/post", "/reddot/list", "/tube", "/tube/play", "/wiki", "/wiki/home", "/wiki/onthisday", "/books", "/books/home", "/books/list", "/books/book"],
)
def test_an_app_route_is_limited_as_an_api_path(path):
    limited, content = http._rate_class(path)
    assert limited and not content, path


def test_a_lookalike_path_is_not_swept_in():
    assert http._rate_class("/exchangerate")[0] is False


def test_almanac_background_lookups_use_their_own_bucket():
    ip = "203.0.113.21"
    for b in (http._rate_buckets, http._rate_buckets_almanac):
        b.pop(ip, None)
    try:
        assert {"/almanac-links", "/almanac-place"} <= http._ALMANAC_BACKGROUND_PATHS
        for _ in range(http.RATE_LIMIT_CONTENT):
            assert http._check_rate_limit(ip, content=True, buckets=http._rate_buckets_almanac) == 0
        assert http._check_rate_limit(ip, content=True, buckets=http._rate_buckets_almanac) > 0
        assert http._check_rate_limit(ip, limit=http.RATE_LIMIT) == 0, "the taps' budget is untouched"
    finally:
        for b in (http._rate_buckets, http._rate_buckets_almanac):
            b.pop(ip, None)
