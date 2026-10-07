"""The Create page's scope options reach the crawl, checked on the way in.

The crawl itself (every scope kind, include, exclude, extra hops, robots per
origin, zimit's flags) is in test_creator_site.py. This is the web's half:
/manage/create takes the same options, refuses a bad one before a job
exists, and hands what it took to the engine.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.crawler as crawler  # noqa: E402
import zimi.manage as manage  # noqa: E402

SITE = {"mode": "site", "source": "https://www.example.org/python/tutorial/"}


def _opts(**fields):
    return manage._create_validate(dict(SITE, **fields))[3]


def test_nothing_chosen_sends_nothing():
    opts = _opts()
    for key in ("scope", "include", "exclude", "extra_hops"):
        assert key not in opts


def test_the_options_are_taken_in_either_shape():
    opts = _opts(
        scope="Host", include="/a/", exclude=["/b/", " ", "/c/"], extra_hops="2"
    )
    assert opts["scope"] == "host"
    assert opts["include"] == ["/a/"]
    assert opts["exclude"] == ["/b/", "/c/"]
    assert opts["extra_hops"] == 2


@pytest.mark.parametrize(
    "fields, said",
    [
        ({"scope": "planet"}, "unknown scope"),
        ({"include": "(unclosed"}, "not a valid regular expression"),
        ({"exclude": ["x"] * 21}, "at most 20"),
        ({"extra_hops": 11}, "extra hops"),
    ],
)
def test_a_bad_option_is_refused_before_a_job_exists(fields, said):
    with pytest.raises(ValueError, match=said):
        manage._create_validate(dict(SITE, **fields))


def test_a_page_capture_has_no_scope():
    opts = manage._create_validate(
        {"mode": "page", "source": "https://www.example.org/", "scope": "any"}
    )[3]
    assert "scope" not in opts


def test_a_job_hands_them_to_the_engine(monkeypatch):
    seen = {}

    def fake_site(url, **kw):
        seen.update(kw)
        return {}

    monkeypatch.setattr(crawler, "create_site_zim", fake_site)
    job = manage._CreateJob("site", SITE["source"], None)
    manage._create_run(
        job, _opts(scope="host", exclude=["/b/"], extra_hops=1, max_depth=2)
    )
    assert seen["scope"] == "host"
    assert seen["exclude"] == ["/b/"]
    assert seen["extra_hops"] == 1
    assert seen["max_depth"] == 2
    assert "include" not in seen
