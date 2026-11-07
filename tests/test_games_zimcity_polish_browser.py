"""ZimCity, a newcomer's second pass (390 x 844, by touch): a footprint aimed beside a road lands flush against it, the
advisor names unwired zones, How to play teaches the fingers, and the small things a phone showed.

Run: pytest tests/test_games_zimcity_polish_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_games_zimcity_browser import (  # noqa: E402,F401
    CLEAR,
    OURS,
    browser,
    funds,
    hold_more,
    phone,
    site,
    stroke,
    touch,
)

SHOTS = os.environ.get("SHOTS")


def shot(pg, name):
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


ROAD_ACROSS = """(y) => import('./zimcity-tools.js').then((T) => { const z = window.__zimcity, v = z.view, r = v.canvas.getBoundingClientRect(), t = v.tileAt(v.w / 2, y - r.top);
  T.build(z.city, 'road', [[t.x - 5, t.y]].concat(T.steps([t.x - 5, t.y], [t.x + 5, t.y]))); return [t.x, t.y]; })"""


def test_a_home_tapped_just_under_a_road_lands_flush_against_it(browser, site):
    """The footprint is wider than a fingertip: a tap one tile under a road used to say "In the way: Road" and build
    nothing. It goes to the nearest place it fits, flush under the road, and the ghost shows that place.
    """
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    y = box["top"] + box["h"] * 0.5
    road = pg.evaluate(ROAD_ACROSS, y)
    pg.click('.cy-tool[data-tool="residential"]')
    before = funds(pg)
    touch(pg, "touchStart", [(box["w"] / 2, y + 30)])
    touch(pg, "touchMove", [(box["w"] / 2 + 1, y + 30)])
    pg.wait_for_timeout(100)
    ghost = pg.evaluate("() => window.__zimcity.view.ghost")
    assert ghost["ok"], pg.text_content("#cy-held")
    left, top = ghost["boxes"][0][:2]
    assert top == road[1] + 1, (ghost["boxes"], road)  # the row right under the road
    shot(pg, "zimcity-home-flush")
    touch(pg, "touchEnd", [])
    pg.wait_for_timeout(120)
    assert before - funds(pg) == 100
    assert pg.evaluate(
        "([x, y]) => window.__zimcity.city.map.getTile(x, y).isZone()",
        [left + 1, top + 1],
    )


def test_unwired_zones_are_asked_to_be_connected_in_four_words(browser, site):
    from test_games_zimcity_browser import TOWN

    pg = phone(browser, site)
    pg.evaluate(TOWN)
    pg.wait_for_timeout(1300)
    assert pg.text_content("#cy-msg") == "Connect the zones to power"
    shot(pg, "zimcity-connect-power")
