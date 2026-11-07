"""ZimCity, a newcomer's second pass (390 x 844, by touch): a footprint aimed beside a road lands flush against it, the
advisor names unwired zones, How to play teaches the fingers, and the small things a phone showed.

Run: pytest tests/test_games_zimcity_polish_browser.py -v
"""

import os
import re
import sys

import pytest

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
    text = pg.evaluate(
        "() => document.querySelector('dl.gs-help').parentElement.innerText"
    )
    assert "Arrow keys" not in text and "Keys" not in text, text
    assert "coal plant" in text
    rows = pg.evaluate(
        "() => [...document.querySelectorAll('.cy-how-row')].map(r => [r.querySelectorAll('svg').length, r.textContent.trim()])"
    )
    assert rows[:3] == [
        [1, "Drag: move"],
        [1, "Pinch: zoom"],
        [1, "Hold: inspect"],
    ], rows
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
    assert (
        "Goal: traffic below 35" in got["text"]
        and ("Now %d" % at_start["now"]) in got["text"]
    ), got
    pg.wait_for_timeout(1200)
    assert "Connect the zones to power" not in pg.evaluate(
        "() => window.__zimcity.said()"
    ), "one zone off the grid in 194 is not the next step"
    shot(pg, "zimcity-bern-opening")
    pg.evaluate("() => ZimiShell.saveNow()")
    pg.reload()
    pg.wait_for_function(
        "() => window.__zimcity && window.__zimcity.city && window.__zimcity.city.scenario"
    )
    after = pg.evaluate(reading)
    assert after["now"] > 35, after


def test_the_coal_plants_chimney_frames_are_the_plant_with_smoke_not_the_1989_pixels(
    browser, site
):
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


def test_a_refusal_line_goes_away_by_itself(browser, site):
    """ "Short by $2,954" stayed red under the tool for as long as the tool was held."""
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.evaluate("() => { window.__zimcity.city.sim.budget.totalFunds = 50; }")
    hold_more(pg, "Coal plant")
    stroke(
        pg,
        [
            (box["w"] / 2, box["top"] + box["h"] / 2),
            (box["w"] / 2 + 1, box["top"] + box["h"] / 2),
        ],
    )
    assert "Short by" in pg.text_content("#cy-held")
    shot(pg, "zimcity-refusal")
    pg.wait_for_function(
        "() => !document.getElementById('cy-held').classList.contains('cy-bad')",
        timeout=5000,
    )
    assert pg.text_content("#cy-held") == "Coal plant: $3,000"


def _open(browser, site, width, height, lang="en"):
    ctx = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        locale=lang,
    )
    pg = ctx.new_page()
    pg.goto(site + "zimcity.html#lang=" + lang)
    pg.wait_for_function(
        "() => window.__zimcity && window.__zimcity.city && document.getElementById('cy-funds').textContent"
    )
    pg.wait_for_timeout(300)
    return pg


@pytest.mark.parametrize(
    "lang", ["en", "es", "de", "ru", "fr", "pt", "ar", "he", "hi", "zh"]
)
def test_the_title_is_whole_beside_the_bars_buttons_in_every_language(
    browser, site, lang
):
    """Spanish clipped the title to "Zi..." and German and Russian squeezed it out: Undo and Pause are pictures now."""
    pg = _open(browser, site, 390, 844, lang)
    got = pg.evaluate(
        "() => { const h = document.querySelector('.ar-bar h1'); return [h.scrollWidth, h.clientWidth, document.documentElement.scrollWidth - innerWidth]; }"
    )
    assert got[0] <= got[1] and got[2] <= 0, got
    if lang in ("es", "ru"):
        shot(pg, "zimcity-title-" + lang)


def test_a_phone_on_its_side_gives_the_map_the_height_and_the_menu_fits(browser, site):
    """Landscape (844 x 390): the map was 270 px tall under a bar, a strip and a line, the tools 43 px wide, and the Menu's card ran
    past the screen's foot. The strip, the line and the tools stand in a column; the map is the rest.
    """
    pg = _open(browser, site, 844, 390)
    got = pg.evaluate(
        """() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { map: r('#cy-map').height, tool: r('.cy-tool').width, toolH: r('.cy-tool').height, over: document.documentElement.scrollWidth - innerWidth, foot: r('.cy-foot').bottom }; }"""
    )
    assert (
        got["map"] >= 320
        and got["tool"] >= 44
        and got["toolH"] >= 44
        and got["over"] <= 0
        and got["foot"] <= 390
    ), got
    shot(pg, "zimcity-landscape")
    pg.click(".gs-menu-btn")
    pg.wait_for_timeout(300)
    card = pg.evaluate(
        "() => { const b = document.querySelector('.ar-sheet-card').getBoundingClientRect(); return [b.top, b.bottom, innerHeight]; }"
    )
    assert card[1] <= card[2], card
    shot(pg, "zimcity-landscape-menu")


def test_before_the_first_picture_the_map_is_the_lands_colour_not_a_blank_sheet(
    browser, site
):
    """The map was empty for the first seconds on a slow link (the art is fetched and cut first). Its stage is the ground's
    own colour meanwhile."""
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
    )
    pg = ctx.new_page()
    pg.route(
        "**/zimcity/tiles.png", lambda route: None
    )  # never answered: the art does not arrive
    pg.goto(site + "zimcity.html", wait_until="commit")
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
    pg.wait_for_timeout(300)
    got = pg.evaluate(
        "() => { const s = getComputedStyle(document.querySelector('.cy-stage')).backgroundColor, c = document.getElementById('cy-map'); return [s, c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data[3]]; }"
    )
    assert got == [
        "rgb(205, 191, 152)",
        0,
    ], got  # nothing drawn yet, and the stage under it is the ground
    if (
        SHOTS
    ):  # the page never finishes loading (the art is held), so Playwright's own screenshot would wait for it
        import base64

        data = ctx.new_cdp_session(pg).send(
            "Page.captureScreenshot", {"format": "png"}
        )["data"]
        with open(os.path.join(SHOTS, "zimcity-before-the-map.png"), "wb") as f:
            f.write(base64.b64decode(data))
    ctx.close()


@pytest.mark.parametrize("lang", ["en", "ru"])
def test_the_road_says_before_the_stroke_what_a_bridge_costs(browser, site, lang):
    """"$10 a tile" was all it said; a road over water is $50 a tile and the total came as a surprise."""
    pg = _open(browser, site, 390, 844, lang)
    pg.click('.cy-tool[data-tool="road"]')
    if lang == "en":
        assert pg.text_content("#cy-held") == "Road: $10 a tile, $50 over water"
    got = pg.evaluate("() => { const h = document.getElementById('cy-held'); return [h.scrollHeight, h.clientHeight, document.documentElement.scrollWidth - innerWidth]; }")
    assert got[0] <= got[1] + 1 and got[2] <= 0, got
    shot(pg, "zimcity-road-held-" + lang)


def test_a_kept_city_opens_with_its_people_not_zero(browser, site):
    """Opening a kept city from Cities showed "0 people" until the year's evaluation."""
    from test_games_zimcity_browser import COMMUTERS, OURS

    pg = phone(browser, site)
    pg.evaluate("() => localStorage.removeItem('zimi.zimcity.kept')")
    pg.evaluate(COMMUTERS)
    had = pg.evaluate("() => window.__zimcity.city.sim.evaluation.cityPop")
    assert had > 0
    pg.click(".gs-menu-btn")
    pg.click("#cy-cities")
    pg.click(OURS + " .cy-keep")
    pg.keyboard.press("Escape")
    pg.evaluate("() => document.getElementById('cy-new').click()")   # a new city takes the place of this one
    pg.wait_for_timeout(200)
    pg.keyboard.press("Escape")
    pg.click(".gs-menu-btn")
    pg.click("#cy-cities")
    pg.click(OURS + " .cy-kept .ar-btn >> nth=0")
    pg.wait_for_timeout(100)
    text = pg.text_content("#cy-when")
    assert format(had, ",") in text, (had, text)
