"""The creation survey's site list and job matrix are data; these pin the
shape the runner and the report rely on."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.survey_sites import SITES, matrix  # noqa: E402


def test_twenty_six_sites_and_twelve_have_a_released_zim():
    assert len(SITES) == 26
    assert sum(1 for s in SITES if s.released) == 12
    assert len({s.key for s in SITES}) == 26, "keys name folders; they must be unique"


def test_the_matrix_covers_every_site_with_every_engine():
    jobs = matrix()
    page = [j for j in jobs if j.mode == "page"]
    assert len(page) == 78
    for s in SITES:
        assert {j.engine for j in page if j.site.key == s.key} == {
            "builtin",
            "rendered",
            "alive",
        }
    site_jobs = [j for j in jobs if j.mode == "site"]
    assert len(site_jobs) == 24
    assert all(j.extra["max_pages"] == 25 for j in site_jobs)
    assert all(j.site.released for j in site_jobs)
    assert len([j for j in jobs if j.mode == "video"]) == 2
    assert len(jobs) == 104
