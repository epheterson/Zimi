"""The search sheet's rows: a row's picture is the thing itself (the body's disc, the craft's model); the only marks are
a walking figure on a place to stand (a landing, a pad: the ground, walk or drive) and a rocket on a mission (a launch you watch). No cube, no flag.

Run: pytest tests/test_almanac_rowmarks_browser.py -v
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import no_map  # noqa: E402,F401  (a fixture)
from test_almanac_ux3d_browser import three_d  # noqa: E402,F401  (a fixture)

ROWS = """() => Array.from(document.querySelectorAll('#ae-go-groups .ae-go-row[data-ae-go]')).map(b => {
  var k = b.getAttribute('data-ae-go'), m = b.querySelector('.ae-go-mark'), r = m && m.getBoundingClientRect(), th = b.querySelector('.ae-go-thumb'), t = th ? th.getBoundingClientRect() : { right: 1e9, bottom: 1e9 };
  return { key: k, kind: _aeGoMarkKind(k), mark: m ? m.getAttribute('data-mark') : '', flag: !!b.querySelector('.ae-go-flag'),
           inside: !r || (r.right <= t.right + 4 && r.bottom <= t.bottom + 4 && r.width >= 14) }; })"""


def test_only_a_landing_wears_a_walker_and_only_a_mission_or_a_pad_a_rocket(three_d):
    pg = three_d
    pg.wait_for_function("() => !_ae.fly", timeout=120_000, polling=200)
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible", timeout=30_000)
    pg.wait_for_function("() => !!_aeLm", timeout=60_000)
    pg.evaluate("() => _aeLmEarthLoad && _aeLmEarthLoad()")
    pg.click("[data-ae-pill=landings]")
    pg.wait_for_function(
        "() => document.querySelectorAll('#ae-go-groups .ae-go-row[data-ae-go^=\"lm:\"]').length > 0",
        timeout=30_000,
    )
    pg.wait_for_function(
        "() => !!document.querySelector('#ae-go-groups .ae-go-mark[data-mark=walk]')",
        timeout=60_000,
    )  # a landing's walker is on its row from the start (a part's cue is its kind, no longer waiting on the site code)
    rows = pg.evaluate(ROWS)
    if os.environ.get("SHEET_SHOTS"):
        os.makedirs(os.environ["SHEET_SHOTS"], exist_ok=True)
        pg.screenshot(path=os.path.join(os.environ["SHEET_SHOTS"], "05-row-marks.png"))
    kinds = {r["key"].split(":")[0]: r["mark"] for r in rows if r["mark"]}
    assert kinds.get("lm") == "walk", rows[:5]  # a landing: the ground
    assert all(
        r["mark"] == r["kind"] for r in rows
    ), rows  # a row's mark is what _aeGoMarkKind says, nothing else
    assert not [
        r
        for r in rows
        if r["mark"] and r["key"].split(":")[0] not in ("lm", "ms", "pad")
    ], rows
    assert not any(
        r["flag"] for r in rows
    ), rows  # the flag the landing wore is the walker now
    assert all(
        r["inside"] for r in rows
    ), rows  # at the picture's lower right, 15 px at least
    for key, want in (
        ("iss", ""),
        ("earth", ""),
        ("moon", ""),
        ("ms:apollo11", "launch"),
        ("pad:apollo11", "walk"),
    ):
        assert pg.evaluate("(k) => _aeGoMarkKind(k)", key) == want, key
    assert not pg.errors, pg.errors
