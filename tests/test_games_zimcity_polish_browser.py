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


def test_how_to_play_teaches_the_fingers_not_the_keyboard(browser, site):
    """On a phone: drag, pinch and hold are shown (icons, a few words), the zone sizes are shown, the coal plant is named,
    and there is no keyboard line."""
    pg = phone(browser, site)
    pg.click(".gs-menu-btn")
    pg.click(".gs-tile >> text='How to play'")
    card = pg.wait_for_selector("dl.gs-help")
    text = pg.evaluate("() => document.querySelector('dl.gs-help').parentElement.innerText")
    assert "Arrow keys" not in text and "Keys" not in text, text
    assert "coal plant" in text
    rows = pg.evaluate("() => [...document.querySelectorAll('.cy-how-row')].map(r => [r.querySelectorAll('svg').length, r.textContent.trim()])")
    assert rows[:3] == [[1, "Drag: move"], [1, "Pinch: zoom"], [1, "Hold: inspect"]], rows
    assert rows[3] == [4, "3 × 34 × 4"], rows
    over = pg.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    assert over <= 0, over
    shot(pg, "zimcity-how-to-play")
    assert card


def test_bern_opens_over_its_traffic_goal_and_so_does_a_reloaded_one(browser, site):
    """The scenario file has no traffic in it: the strip used to read "Now 6" against "below 80", a goal already met. The
    reading is a measured city's, over the goal, on opening and after a reload."""
    from test_games_zimcity_goal_browser import GOAL_BOX, _page, _play

    pg = _page(browser, site)
    _play(pg, 3)  # Bern
    reading = "() => window.__zimcity.city.scenario && (async () => { const S = await import('./zimcity-scenarios.js'); return S.reading(window.__zimcity.city.sim, S.SCENARIOS.find(s => s.id === 'bern')); })()"
    at_start = pg.evaluate(reading)
    assert at_start["target"] == 35 and at_start["now"] > 35, at_start
    got = pg.evaluate(GOAL_BOX)
    assert "Goal: traffic below 35" in got["text"] and ("Now %d" % at_start["now"]) in got["text"], got
    pg.wait_for_timeout(1200)
    assert "Connect the zones to power" not in pg.evaluate("() => window.__zimcity.said()"), "one zone off the grid in 194 is not the next step"
    shot(pg, "zimcity-bern-opening")
    pg.evaluate("() => ZimiShell.saveNow()")
    pg.reload()
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city && window.__zimcity.city.scenario")
    after = pg.evaluate(reading)
    assert after["now"] > 35, after


def test_the_coal_plants_chimney_frames_are_the_plant_with_smoke_not_the_1989_pixels(browser, site):
    """The four animated chimney tiles used to keep the original art (pixel noise and a yellow outline over the redrawn
    plant). Each of their 16 frames is now the plant's own tile with a puff over it."""
    pg = phone(browser, site)
    same = pg.evaluate("""() => {
      const a = window.__zimcity.view.tileArt(), ctx = a.getContext('2d'), per = a.width / 32, out = [];
      const px = (t) => ctx.getImageData((t % per) * 32, Math.floor(t / per) * 32, 32, 32).data;
      [2, 3, 6, 7].forEach((tile, i) => { for (let f = 0; f < 4; f++) {
        const base = px(750 - 5 + tile), frame = px(916 + i * 4 + f);   // the plant's centre is 750; its first tile is 5 before
        let n = 0; for (let k = 0; k < base.length; k += 4) if (base[k] === frame[k] && base[k + 1] === frame[k + 1] && base[k + 2] === frame[k + 2]) n++;
        out.push(n / 1024); } });
      return out; }""")
    assert len(same) == 16 and min(same) > 0.75, same
