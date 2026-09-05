"""The survey's flow measurements are pure functions over the progress lines
the create API streams; these pin what a gap and a backwards counter are."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.survey_measure import flow_facts  # noqa: E402


def test_flow_facts_reads_gaps_and_backwards_counters():
    ev = [
        {"ts": 10.0, "line": "fetching https://e.com/"},
        {"ts": 10.4, "line": "carried 12 assets, 4000 bytes"},
        {"ts": 25.0, "line": "carried 9 assets, 9000 bytes"},
        {"ts": 26.0, "line": "ZIM written"},
    ]
    f = flow_facts(ev, started=9.5)
    assert f["first_line_s"] == 0.5
    assert f["longest_gap_s"] == 14.6
    assert f["backwards"] == ["carried 9 assets, 9000 bytes"]
    assert f["lines"] == 4


def test_flow_facts_with_no_lines_is_honest_not_zero():
    f = flow_facts([], started=1.0)
    assert f["first_line_s"] is None
    assert f["longest_gap_s"] is None
    assert f["lines"] == 0


def test_a_counter_that_only_climbs_is_not_backwards():
    ev = [
        {"ts": 1.0, "line": "  [1/25] https://e.com/  (3 queued, 1.2 MB fetched)"},
        {"ts": 2.0, "line": "  [2/25] https://e.com/a  (7 queued, 2.0 MB fetched)"},
        {"ts": 3.0, "line": "archived 94 image variants"},
    ]
    assert flow_facts(ev, started=0.0)["backwards"] == []
