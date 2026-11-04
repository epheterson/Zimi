"""ZimCity on a phone, by touch: the map draws, a road laid by a finger costs what its ghost said, a zone goes down with
a tap, a long press inspects, the city survives a reload, and nothing scrolls sideways at 375 and 390 px.

The engine and the tools' arithmetic are in test_games_zimcity.cjs; this drives the page as a thumb does.

Run: pytest tests/test_games_zimcity_browser.py -v
"""

import functools
import http.server
import os
import re
import threading

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    handler.extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{".js": "text/javascript"},
    )
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


def phone(browser, site, width=390):
    ctx = browser.new_context(
        viewport={"width": width, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
    )
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(site + "zimcity.html")
    pg.wait_for_function(
        "() => window.__zimcity && window.__zimcity.city && document.getElementById('cy-funds').textContent"
    )
    pg.evaluate(
        "() => document.getElementById('cy-pause').click()"
    )  # a still city: only the finger changes it
    pg.cdp = ctx.new_cdp_session(pg)
    return pg


def touch(pg, kind, pts):
    pg.cdp.send(
        "Input.dispatchTouchEvent",
        {
            "type": kind,
            "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)],
        },
    )


def stroke(pg, pts):
    touch(pg, "touchStart", [pts[0]])
    for p in pts[1:]:
        touch(pg, "touchMove", [p])
        pg.wait_for_timeout(16)
    touch(pg, "touchEnd", [])
    pg.wait_for_timeout(120)


def funds(pg):
    return pg.evaluate("() => window.__zimcity.city.sim.budget.totalFunds")


# Clear ground under the screen's middle rows, so a stroke there is never blocked by trees or water.
CLEAR = """() => {
  const z = window.__zimcity, v = z.view, map = z.city.map;
  const a = v.tileAt(0, v.h * 0.35), b = v.tileAt(v.w, v.h * 0.75);
  for (let y = Math.max(0, a.y); y <= Math.min(map.height - 1, b.y); y++)
    for (let x = Math.max(0, a.x); x <= Math.min(map.width - 1, b.x); x++) map.setTile(x, y, 0, 0);
  return { top: v.canvas.getBoundingClientRect().top, h: v.h, w: v.w };
}"""


def test_the_map_draws(browser, site):
    pg = phone(browser, site)
    pg.wait_for_timeout(400)
    seen = pg.evaluate("""() => {
      const c = document.getElementById('cy-map'), ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data; let lit = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
      return lit / (d.length / (4 * 97));
    }""")
    assert seen > 0.95, seen
    assert not pg.errors, pg.errors


def test_a_road_by_finger_costs_what_its_ghost_said(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="road"]')
    y = box["top"] + box["h"] * 0.5
    pts = [(x, y) for x in range(30, int(box["w"]) - 30, 12)]
    before = funds(pg)
    touch(pg, "touchStart", [pts[0]])
    for p in pts[1:]:
        touch(pg, "touchMove", [p])
        pg.wait_for_timeout(16)
    said = pg.evaluate("() => document.getElementById('cy-held').textContent")
    ghost = pg.evaluate(
        "() => window.__zimcity.view.ghost && window.__zimcity.view.ghost.ok"
    )
    assert funds(pg) == before, "nothing is spent while the finger is down"
    touch(pg, "touchEnd", [])
    pg.wait_for_timeout(150)
    spent = before - funds(pg)
    shown = int(re.sub(r"[^0-9]", "", said.split(":")[-1]))
    assert ghost is True and spent > 0 and spent == shown, (said, spent)
    assert pg.evaluate("() => window.__zimcity.view.ghost") is None


def test_a_zone_goes_down_with_a_tap_and_a_long_press_inspects_it(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="residential"]')
    x, y = box["w"] / 2, box["top"] + box["h"] * 0.55
    before = funds(pg)
    stroke(pg, [(x, y), (x + 1, y)])
    assert before - funds(pg) == 100
    pg.click('.cy-tool[data-tool="residential"]')  # put the tool down
    touch(pg, "touchStart", [(x, y)])
    pg.wait_for_timeout(750)
    touch(pg, "touchEnd", [])
    title = pg.wait_for_selector(".ar-sheet-card h2").text_content()
    assert title == "Homes", title
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(100)
    assert not pg.query_selector(".ar-sheet")


def test_a_short_city_shows_a_red_ghost_and_builds_nothing(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.evaluate("() => { window.__zimcity.city.sim.budget.totalFunds = 50; }")
    pg.click('.cy-tool[data-tool="more"]')
    pg.click(".cy-more-tool >> nth=7")  # the coal plant, $3,000
    x, y = box["w"] / 2, box["top"] + box["h"] * 0.55
    touch(pg, "touchStart", [(x, y)])
    touch(pg, "touchMove", [(x + 1, y)])
    pg.wait_for_timeout(60)
    assert pg.evaluate("() => window.__zimcity.view.ghost.ok") is False
    assert "2,950" in pg.evaluate(
        "() => document.getElementById('cy-held').textContent"
    )
    touch(pg, "touchEnd", [])
    pg.wait_for_timeout(100)
    assert funds(pg) == 50


def test_the_city_comes_back_after_a_reload(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="road"]')
    y = box["top"] + box["h"] * 0.5
    stroke(pg, [(x, y) for x in range(40, 200, 12)])
    pg.evaluate("() => window.__zimcity.step(200)")
    kept = pg.evaluate(
        "() => { const c = window.__zimcity.city; return { funds: c.sim.budget.totalFunds, t: c.sim._cityTime, seed: c.seed }; }"
    )
    pg.evaluate("() => window.ZimiShell.saveNow()")
    pg.reload()
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
    back = pg.evaluate(
        "() => { const c = window.__zimcity.city; return { funds: c.sim.budget.totalFunds, t: c.sim._cityTime, seed: c.seed }; }"
    )
    assert (
        back["seed"] == kept["seed"]
        and back["funds"] == kept["funds"]
        and back["t"] >= kept["t"]
    ), (kept, back)


@pytest.mark.parametrize("width", [375, 390])
def test_nothing_scrolls_sideways_and_the_tray_fits(browser, site, width):
    pg = phone(browser, site, width)
    r = pg.evaluate("""() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      tools: Array.from(document.querySelectorAll('.cy-tool')).map(b => { const r = b.getBoundingClientRect(); return [r.left, r.right, r.height]; })
    })""")
    assert r["sw"] <= r["cw"], r
    assert len(r["tools"]) == 7 and all(
        t[0] >= 0 and t[1] <= width and t[2] >= 44 for t in r["tools"]
    ), r["tools"]


OURS = ".ar-sheet:not(.gs-sheet)"   # the Menu's own sheet stays in the page, hidden, once it has opened


def test_a_sheet_opened_from_the_menu_holds_the_focus(browser, site):
    """Budget, City report, Layers and Speed live in the Menu; the Menu closing after the tap must not take the focus
    back out of the sheet they open, or Escape and the focus trap do nothing."""
    pg = phone(browser, site)
    for button in ("cy-budget", "cy-report", "cy-layers", "cy-speed"):
        pg.click(".gs-menu-btn")
        pg.click("#" + button)
        pg.wait_for_selector(OURS + " .ar-sheet-card")
        pg.wait_for_timeout(50)
        assert pg.evaluate("() => !!document.activeElement.closest('.ar-sheet')"), button
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(80)
        assert not pg.query_selector(OURS), button


def test_the_city_runs_again_once_the_menu_has_closed(browser, site):
    """The Menu's sheet stays in the page, hidden, after its first opening: the clock must not take that for a sheet
    still up and stop the city for good."""
    pg = phone(browser, site)
    pg.evaluate("() => document.getElementById('cy-pause').click()")   # running again
    pg.click(".gs-menu-btn")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(100)
    if pg.evaluate("() => document.getElementById('cy-pause').getAttribute('data-t')") == "play.resume":
        pg.click("#cy-pause")   # the Menu paused it, as it pauses every game
    t0 = pg.evaluate("() => window.__zimcity.city.sim._cityTime")
    pg.wait_for_timeout(1500)
    assert pg.evaluate("() => window.__zimcity.city.sim._cityTime") > t0


def test_a_drag_with_a_zone_lays_a_row_and_undo_takes_the_last_one_back(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="residential"]')
    y = box["top"] + box["h"] * 0.55
    before = funds(pg)
    tile = pg.evaluate("() => 16 * window.__zimcity.view.cam.s")   # one tile on screen
    stroke(pg, [(60 + i * tile, y) for i in range(0, 8)])   # seven tiles to the right: three zones side by side
    assert before - funds(pg) == 300, before - funds(pg)
    assert pg.evaluate("() => !document.getElementById('cy-undo').disabled")
    pg.click("#cy-undo")
    assert funds(pg) == before
    assert pg.evaluate("() => document.getElementById('cy-undo').disabled")


def test_an_unpowered_zone_says_why_it_is_not_growing(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="residential"]')
    x, y = box["w"] / 2, box["top"] + box["h"] * 0.55
    stroke(pg, [(x, y), (x + 1, y)])
    pg.click('.cy-tool[data-tool="residential"]')
    touch(pg, "touchStart", [(x, y)])
    pg.wait_for_timeout(750)
    touch(pg, "touchEnd", [])
    why = pg.wait_for_selector(".cy-why").text_content()
    assert "no power" in why and "no road beside it" in why, why


def test_paused_is_a_speed(browser, site):
    pg = phone(browser, site)   # phone() leaves the city paused
    pg.click(".gs-menu-btn")
    pg.click("#cy-speed")
    pg.wait_for_selector(OURS + " .gs-seg")
    pressed = pg.evaluate("() => document.querySelector('.ar-sheet:not(.gs-sheet) [aria-pressed=\"true\"]').textContent")
    assert pressed == "Paused", pressed
    pg.click(OURS + " .gs-seg button >> nth=2")   # Normal
    pg.keyboard.press("Escape")
    assert pg.evaluate("() => document.getElementById('cy-pause').getAttribute('data-t')") == "play.pause"


def test_a_new_city_opens_on_open_ground_with_the_first_step(browser, site):
    pg = phone(browser, site)
    pg.evaluate("() => localStorage.clear()")
    for seed_try in range(3):   # three fresh maps
        pg.reload()
        pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
        clear = pg.evaluate("""() => { const v = window.__zimcity.view, map = window.__zimcity.city.map, a = v.tileAt(v.w * 0.2, v.h * 0.3), b = v.tileAt(v.w * 0.8, v.h * 0.7);
          let n = 0, all = 0; for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) { all++; const v = map.testBounds(x, y) ? map.getTileValue(x, y) : 2; if (v < 2 || v > 20) n++; } return n / all; }""")
        assert clear > 0.9, clear   # land, not water (woods are cleared for a dollar a tile)
        pg.evaluate("() => localStorage.clear()")
    assert pg.wait_for_selector("#cy-msg").text_content() == "Lay a road: choose Road and drag"


def test_keep_open_and_delete_a_city(browser, site):
    pg = phone(browser, site)
    pg.evaluate("() => localStorage.removeItem('zimi.zimcity.kept')")
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="road"]')
    y = box["top"] + box["h"] * 0.5
    stroke(pg, [(x, y) for x in range(40, 200, 12)])
    first = funds(pg)
    pg.click(".gs-menu-btn")
    pg.click("#cy-cities")
    pg.click(OURS + " .cy-keep")
    assert pg.evaluate("() => JSON.parse(localStorage.getItem('zimi.zimcity.kept')).length") == 1
    pg.keyboard.press("Escape")
    stroke(pg, [(x, y + 40) for x in range(40, 200, 12)])   # the city moves on after it was kept
    second = funds(pg)
    assert second < first
    pg.click(".gs-menu-btn")
    pg.click("#cy-cities")
    pg.click(OURS + " .cy-kept .ar-btn >> nth=0")   # Open: the kept city comes back, the one in progress takes its place
    pg.wait_for_timeout(200)
    assert funds(pg) == first
    kept = pg.evaluate("() => JSON.parse(localStorage.getItem('zimi.zimcity.kept'))")
    assert len(kept) == 1 and kept[0]["funds"] == second
    pg.click(".gs-menu-btn")
    pg.click("#cy-cities")
    pg.click(OURS + " .cy-kept .ar-btn >> nth=1")
    assert pg.evaluate("() => JSON.parse(localStorage.getItem('zimi.zimcity.kept')).length") == 1   # asked first
    pg.click(OURS + " .cy-kept .ar-btn >> nth=1")
    pg.wait_for_timeout(100)
    assert pg.evaluate("() => JSON.parse(localStorage.getItem('zimi.zimcity.kept')).length") == 0


def test_the_redrawn_roads_follow_the_engines_shapes(browser, site):
    """The modern atlas reads each road tile's edges from the original picture: a straight runs one way, a crossing
    all four, a T three; the light theme's asphalt is #3b3d42 and the ground #cdbf98."""
    pg = phone(browser, site)
    got = pg.evaluate("""() => {
      const a = window.__zimcity.view.tileArt(), ctx = a.getContext('2d'), ART = 32;
      const road = (t, x, y) => { const d = ctx.getImageData((t % 32) * ART + x, Math.floor(t / 32) * ART + y, 1, 1).data; return d[0] === 0x3b && d[1] === 0x3d && d[2] === 0x42; };
      const ways = (t) => [road(t, 16, 1), road(t, 30, 13), road(t, 16, 30), road(t, 1, 13)].map(Number).join('');
      return { h: ways(66), v: ways(67), cross: ways(76), heavy: ways(144 + 12), t: ways(75) };
    }""")
    assert got == {"h": "0101", "v": "1010", "cross": "1111", "heavy": "1111", "t": "1011"}, got


TOWN = """async () => {
  const T = await import('./zimcity-tools.js'), z = window.__zimcity, c = z.city, map = c.map, v = z.view;
  v.centreOn(60, 50);   // the middle of the map, so the town is wholly on it
  const x0 = 50, y0 = 38;
  for (let y = y0; y < y0 + 26; y++) for (let x = x0; x < x0 + 22; x++) map.setTile(x, y, 0, 0);
  c.sim.budget.totalFunds = 100000;
  const line = (a, b) => [a].concat(T.steps(a, b));
  T.build(c, 'road', line([x0, y0 + 6], [x0 + 21, y0 + 6])); T.build(c, 'road', line([x0 + 10, y0], [x0 + 10, y0 + 25]));
  T.build(c, 'coal', [[x0 + 2, y0 + 2]]);
  for (let i = 0; i < 3; i++) T.build(c, 'residential', [[x0 + 12 + i * 3, y0 + 8]]);
}"""


def test_the_advisor_follows_a_city_built_without_a_finger(browser, site):
    """A town with roads, a plant and unpowered homes (built by script, as a kept city arrives) is told to run power,
    within a second, not to lay a road."""
    pg = phone(browser, site)
    pg.evaluate(TOWN)
    pg.wait_for_timeout(1300)
    assert pg.evaluate("() => document.getElementById('cy-msg').textContent") == "Run a power line to the zones that flash"


def test_the_city_is_never_painted_whole(browser, site):
    """At 32 px a tile the whole city would be about 50 MB of canvas, more than a phone's browser gives a tab. Only a
    window around the screen is painted, at the detail the screen shows: well under 16 MB at every zoom at 390 px."""
    pg = phone(browser, site)
    seen = {}
    for s in (3, 2, 1, 0.2):
        pg.evaluate("(s) => { const v = window.__zimcity.view; v.cam.s = s; v.clamp(); }", s)
        pg.wait_for_timeout(120)
        seen[s] = pg.evaluate("() => window.__zimcity.view.bytes()")
    assert all(b < 16e6 for b in seen.values()), seen
    sharp = pg.evaluate("() => { const v = window.__zimcity.view; v.cam.s = 2; v.clamp(); v.draw(performance.now()); return v._cache.r; }")
    assert sharp == 32   # a tile 32 CSS px wide at 2x is drawn from the 32 px art


def test_a_scenario_and_a_ready_made_city_open_from_the_menu(browser, site):
    pg = phone(browser, site)
    pg.click(".gs-menu-btn")
    pg.click("#cy-scenarios")
    rows = pg.wait_for_selector(OURS + " .ar-sheet-card")
    assert len(pg.query_selector_all(OURS + " .cy-sc")) == 8 and len(pg.query_selector_all(OURS + " .cy-maps .ar-btn")) == 24
    pg.click(OURS + " .cy-sc >> nth=1 >> .ar-btn")   # San Francisco, 1906
    pg.wait_for_function("() => window.__zimcity.city.scenario")
    got = pg.evaluate("() => { const c = window.__zimcity.city; return { year: c.sim.getDate().year, funds: c.sim.budget.totalFunds, id: c.scenario.id, zones: (() => { let n = 0; for (let y = 0; y < 100; y++) for (let x = 0; x < 120; x++) if (c.map.getTile(x, y).isZone()) n++; return n; })() }; }")
    assert got["year"] == 1906 and got["funds"] == 20000 and got["id"] == "sanfrancisco" and got["zones"] > 50, got
    if os.environ.get("SHOTS"):
        pg.wait_for_timeout(400)
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-sanfrancisco.png"))
    pg.evaluate("() => window.__zimcity.step(16 * 11)")   # past the tenth tick: the earthquake
    # an urgent message goes to the front of the line once the one showing has had its few seconds
    pg.wait_for_function("() => document.getElementById('cy-msg').textContent === 'Earthquake'", timeout=15000)
    pg.click(".gs-menu-btn")
    pg.click("#cy-scenarios")
    pg.click(OURS + " .cy-maps .ar-btn >> text=Kyoto")
    pg.wait_for_function("() => !window.__zimcity.city.scenario && window.__zimcity.city.name === 'Kyoto'")
