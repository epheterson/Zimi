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
    # the art is built on the first frame that has the pictures (a heavy one on a busy machine): wait for the window
    pg.wait_for_function("() => window.__zimcity.view._cache && window.__zimcity.view._cache.painted.every(v => v !== -2)", timeout=20000)
    pg.wait_for_timeout(100)
    # every device pixel over the city itself is drawn (the camera may look a few tiles past the city's edge: not counted)
    seen = pg.evaluate("""() => {
      const v = window.__zimcity.view, c = v.canvas, ctx = c.getContext('2d'), k = v.dpr * v.cam.s;
      const x0 = Math.max(0, Math.ceil(-v.cam.x * k)), y0 = Math.max(0, Math.ceil(-v.cam.y * k));
      const x1 = Math.min(c.width, Math.floor((120 * 16 - v.cam.x) * k)), y1 = Math.min(c.height, Math.floor((100 * 16 - v.cam.y) * k));
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; let lit = 0, n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) { n++; if (d[i] > 0) lit++; }
      return lit / n;
    }""")
    assert seen > 0.99, seen
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


def test_the_advisor_is_the_one_instruction_voice(browser, site):
    """With the advisor speaking and no tool held, the tray's own hint is quiet; holding a tool brings its line back."""
    pg = phone(browser, site)
    pg.evaluate("() => localStorage.clear()")
    pg.reload()
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city && document.getElementById('cy-msg').textContent")
    assert pg.text_content("#cy-held") == ""
    pg.click('.cy-tool[data-tool="road"]')
    assert pg.text_content("#cy-held").startswith("Road")


def test_a_city_whose_land_is_at_its_edge_opens_on_land_not_past_the_edge(browser, site):
    """The open ground is the bottom rows: the first view sits on them, with none of the margin past the map showing."""
    pg = phone(browser, site)
    got = pg.evaluate("""() => { const z = window.__zimcity, map = z.city.map, v = z.view;
      for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) map.setTile(x, y, y >= map.height - 16 ? 0 : 2, 0);
      z.land();
      const a = v.tileAt(0, 0), b = v.tileAt(v.w - 1, v.h - 1);
      return { a, b, w: map.width, h: map.height }; }""")
    assert got["a"]["y"] >= 0 and got["b"]["y"] < got["h"] and got["b"]["y"] == got["h"] - 1, got


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
    assert not pg.query_selector_all(OURS + " .cy-sc .ar-btn") and len(pg.query_selector_all(OURS + " .cy-sc-go .cy-sc-chev")) == 8   # the row plays it
    pg.click(OURS + " .cy-sc >> nth=1 >> .cy-sc-go")   # San Francisco, 1906: the row is the button
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


def test_an_ai_data_center_opens_with_its_news_and_a_citizen_answers(browser, site):
    """Built from More by a tap: the city pays for it, the line says it opened, and one of the citizens has a view."""
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.click('.cy-tool[data-tool="more"]')
    pg.click(OURS + ' .cy-more-tool >> text="AI data center"')
    x, y = box["w"] / 2, box["top"] + box["h"] * 0.55
    before = funds(pg)
    stroke(pg, [(x, y), (x + 1, y)])
    assert before - funds(pg) == 12000
    seen = pg.evaluate("""() => new Promise((done) => {
      const el = document.getElementById('cy-msg'), lines = new Set([el.textContent]);
      new MutationObserver(() => lines.add(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
      setTimeout(() => done([...lines]), 9000);
    })""")
    assert any(l.startswith("The AI data center opens.") for l in seen), seen
    assert any(re.match(r"^(Vivian Crane|Juniper Ash|Dale Pemberton): “.+”$", l) for l in seen), seen
    # The census is cleared at the start of each cycle and filled as the scan passes each row, so a read at any one
    # moment can fall before the scan reaches the data center: the most it counts over two whole cycles is the count.
    most = pg.evaluate("""() => { let most = 0; for (let i = 0; i < 32; i++) { window.__zimcity.step(1);
      most = Math.max(most, window.__zimcity.city.sim._census.zc.data); } return most; }""")
    assert most == 1, most
    assert not pg.errors, pg.errors


def test_the_climate_sheet_says_it_plainly_and_comes_back_after_a_reload(browser, site):
    pg = phone(browser, site)
    pg.evaluate("""() => { const c = window.__zimcity.city; c.climate.carbon = 9000; c.climate.warm = 1.5; c.climate.sea = 0.12; }""")
    pg.click(".gs-menu-btn")
    pg.click("#cy-climate")
    card = pg.wait_for_selector(OURS + " .ar-sheet-card")
    text = card.text_content()
    assert "+1.5 °C" in text and "+12 cm" in text and "A toy model" in text, text
    assert pg.evaluate("() => document.activeElement && !!document.activeElement.closest('.ar-sheet')")
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-climate.png"))
    pg.keyboard.press("Escape")
    pg.evaluate("() => { window.__zimcity.step(4); ZimiShell.saveNow(); }")
    pg.reload()
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
    assert pg.evaluate("() => window.__zimcity.city.climate.carbon") >= 9000


def test_the_climate_sheet_never_says_no_warmth_beside_warming_already_made(browser, site):
    """A city that tore down its coal (or has no power now) keeps the warming it made: the sheet says today's power adds
    none and the warming so far stays, never only "adds no warmth" beside +1.5 °C. A new city with none says it has no power."""
    pg = phone(browser, site)
    def sheet():
        pg.click(".gs-menu-btn")
        pg.click("#cy-climate")
        text = pg.wait_for_selector(OURS + " .ar-sheet-card").text_content()
        pg.keyboard.press("Escape")
        return text
    fresh = sheet()
    assert "The city has no power yet" in fresh and "so far stays" not in fresh, fresh
    pg.evaluate("() => { const c = window.__zimcity.city; c.climate.carbon = 9000; c.climate.warm = 1.5; }")
    after = sheet()
    assert "+1.5 °C" in after and "the warming so far stays" in after and "so it adds no warmth" not in after, after


def test_a_city_saved_before_the_climate_still_opens(browser, site):
    """Saves from 1.15.3 have no climate: they open with none and start counting."""
    pg = phone(browser, site)
    pg.evaluate("() => { window.__zimcity.step(4); ZimiShell.saveNow(); }")
    pg.evaluate("""() => { const k = 'zimi.games.save.zimcity', v = JSON.parse(localStorage.getItem(k));
      if (!('climateOn' in v.data)) throw new Error('no climate in the save');
      delete v.data.climate; delete v.data.climateOn; localStorage.setItem(k, JSON.stringify(v)); }""")
    pg.reload()
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
    got = pg.evaluate("() => { const c = window.__zimcity.city; return { carbon: c.climate.carbon, t: c.sim._cityTime }; }")
    assert got["carbon"] == 0 and got["t"] > 0, got
    assert not pg.errors, pg.errors


def test_the_citizens_speak_in_their_own_names(browser, site):
    pg = phone(browser, site)
    pg.evaluate("() => window.__zimcity.voice()")
    pg.wait_for_function("() => /^(Dale Pemberton|Vivian Crane|Juniper Ash|Gordon Plumb): “.+”$/.test(document.getElementById('cy-msg').textContent)", timeout=10000)


PLANTS = "() => { const m = window.__zimcity.city.map, out = []; for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.getTileValue(x, y) === 750) out.push([x, y]); return out; }"


def hold_more(pg, label):
    pg.click('.cy-tool[data-tool="more"]')
    pg.click(OURS + ' .cy-more-tool >> text="%s"' % label)


def test_a_plant_rides_above_the_finger_and_goes_down_where_it_is_let_go(browser, site):
    """A single building is dragged into place, not laid in a row: one plant, where its ghost was when the finger
    lifted, which is above the finger (the finger never hides it)."""
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    hold_more(pg, "Coal plant")
    x0, y0 = box["w"] * 0.3, box["top"] + box["h"] * 0.72
    x1, y1 = box["w"] * 0.6, box["top"] + box["h"] * 0.68
    before = funds(pg)
    touch(pg, "touchStart", [(x0, y0)])
    for k in range(1, 9):
        touch(pg, "touchMove", [(x0 + (x1 - x0) * k / 8, y0 + (y1 - y0) * k / 8)])
        pg.wait_for_timeout(16)
    want = pg.evaluate("([x, y]) => { const v = window.__zimcity.view, lift = 4 * 16 * v.cam.s / 2 + 28, r = v.canvas.getBoundingClientRect(), t = v.tileAt(x - r.left, y - r.top - lift); return [t.x, t.y]; }", [x1, y1])
    ghost = pg.evaluate("() => window.__zimcity.view.ghost")
    assert ghost["ok"] and len(ghost["boxes"]) == 1, ghost
    touch(pg, "touchEnd", [])
    pg.wait_for_timeout(120)
    assert before - funds(pg) == 3000
    assert pg.evaluate(PLANTS) == [want], (pg.evaluate(PLANTS), want)
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-dragged-plant.png"))


def test_a_plant_let_go_off_the_map_puts_nothing_down(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    hold_more(pg, "Coal plant")
    before = funds(pg)
    x = box["w"] / 2
    stroke(pg, [(x, box["top"] + box["h"] * 0.6 + d) for d in range(0, int(box["h"] * 0.4) + 60, 20)])   # down onto the tray
    assert funds(pg) == before and pg.evaluate(PLANTS) == []
    assert pg.evaluate("() => window.__zimcity.view.ghost") is None


def safe_area(pg, bottom, left=0, right=0, top=0):
    pg.cdp.send("Emulation.setSafeAreaInsetsOverride", {"insets": {"top": top, "bottom": bottom, "left": left, "right": right}})
    pg.wait_for_timeout(150)


LOWEST_CONTROL = "() => Math.max(...[...document.querySelectorAll('.cy-tool')].map((b) => b.getBoundingClientRect().bottom))"


def _settles(pg, bound):
    try:
        pg.wait_for_function("(b) => (" + LOWEST_CONTROL + ")() <= b", arg=bound, timeout=5000)
    except Exception:
        pass
    assert pg.evaluate(LOWEST_CONTROL) <= bound


def test_the_tray_stays_clear_of_the_home_indicator(browser, site):
    pg = phone(browser, site)
    # The layout takes the insets on its next frame: each is read once it has settled (a slow runner lags a frame).
    safe_area(pg, 34, top=47)
    _settles(pg, 844 - 34)
    pg.set_viewport_size({"width": 844, "height": 390})
    safe_area(pg, 21, left=47, right=47)
    _settles(pg, 390 - 21)
    sides = pg.evaluate("() => { const f = document.getElementById('cy-funds').getBoundingClientRect(), t = [...document.querySelectorAll('.cy-tool')].map((b) => b.getBoundingClientRect()); return { left: f.left, right: Math.max(...t.map((r) => r.right)) }; }")
    assert sides["left"] >= 47 and sides["right"] <= 844 - 47, sides


def test_inside_zimi_the_frame_gets_only_the_inset_it_reaches_into(browser, site):
    """WebKit tells a frame its safe-area insets are 0, so the game reads Zimi's own and keeps the part its frame covers.
    (Chromium hands a frame the screen's inset, so this places the frame 20 px above the bottom of a screen with a 34 px
    indicator: the game must pad 14, not 34.)"""
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    pg.goto(site + "zimi-host-test")   # any page of the same origin (Zimi's reader and its games share one)
    ctx.new_cdp_session(pg).send("Emulation.setSafeAreaInsetsOverride", {"insets": {"top": 47, "bottom": 34, "left": 0, "right": 0}})
    pg.evaluate("""(src) => { document.head.innerHTML = '<meta name="viewport" content="width=device-width, viewport-fit=cover">';
      document.body.innerHTML = ''; document.body.style.margin = '0';
      const f = document.createElement('iframe'); f.id = 'reader-frame'; f.src = src;
      f.style.cssText = 'position:fixed;left:0;top:60px;width:100%;height:calc(100% - 80px);border:0'; document.body.appendChild(f); }""", site + "zimcity.html")
    frame = None
    for _ in range(100):
        frame = next((f for f in pg.frames if f.url.endswith("zimcity.html")), None)
        if frame:
            break
        pg.wait_for_timeout(50)
    frame.wait_for_function("() => window.__zimcity && window.__zimcity.city && document.documentElement.classList.contains('gs-hosted')")
    pad = frame.evaluate("() => { const f = document.querySelector('.cy-foot'), cs = getComputedStyle(f), probe = document.createElement('div'); probe.style.paddingTop = 'var(--sp-2)'; f.appendChild(probe); const sp = parseFloat(getComputedStyle(probe).paddingTop); probe.remove(); return parseFloat(cs.paddingBottom) - sp; }")
    assert pad == 14, pad
    ctx.close()


# A town where people live and work: homes north of a long road, shops and industry south, powered, grown for years.
COMMUTERS = """async () => {
  const T = await import('./zimcity-tools.js'), z = window.__zimcity, c = z.city, map = c.map, v = z.view;
  v.centreOn(60, 50);
  const x0 = 46, y0 = 44;
  for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 26; x++) map.setTile(x, y, 0, 0);
  c.sim.budget.totalFunds = 100000;
  T.build(c, 'road', [[x0, y0 + 4]].concat(T.steps([x0, y0 + 4], [x0 + 25, y0 + 4])));
  T.build(c, 'coal', [[x0 + 2, y0 + 1]]);
  for (let i = 0; i < 6; i++) T.build(c, 'residential', [[x0 + 6 + i * 3, y0 + 2]]);
  T.build(c, 'commercial', [[x0 + 6, y0 + 6]]); T.build(c, 'industrial', [[x0 + 18, y0 + 6]]);
  T.build(c, 'wire', [[x0 + 4, y0 + 4], [x0 + 4, y0 + 5], [x0 + 4, y0 + 6]].concat(T.steps([x0 + 4, y0 + 6], [x0 + 16, y0 + 6]).filter((p) => p[0] < x0 + 5 || p[0] > x0 + 7)));
  z.step(6000);
}"""


def test_follow_someone_to_work_along_the_roads(browser, site):
    pg = phone(browser, site)
    pg.evaluate(COMMUTERS)
    pg.click(".gs-menu-btn")
    pg.click("#cy-follow")
    rows = pg.wait_for_selector(OURS + " .ar-sheet-card")
    names = [b.text_content() for b in pg.query_selector_all(OURS + " .cy-kept-what b")]
    assert names == ["Dale Pemberton", "Vivian Crane", "Juniper Ash", "Gordon Plumb"], names
    assert all(q.text_content() for q in pg.query_selector_all(OURS + " .cy-fw-q"))
    pg.click(OURS + " .cy-fw-row .ar-btn >> nth=0")
    pg.wait_for_function("() => window.__zimcity.following && !document.getElementById('cy-follow-card').hidden")
    card = pg.text_content("#cy-follow-card")
    assert "Dale Pemberton" in card and "On the way to work" in card, card
    path = pg.evaluate("() => window.__zimcity.following.walk.trip.path")
    pg.click("#cy-pause")   # the city runs, and the figure with it
    seen = pg.evaluate("""() => new Promise((done) => { const out = [], t0 = performance.now();
      (function look() { const f = window.__zimcity.following, v = window.__zimcity.view, c = v.tileAt(v.w / 2, v.h / 2);
        out.push({ at: f.walk.at, centre: c }); if (performance.now() - t0 < 2500) requestAnimationFrame(look); else done(out); })(); })""")
    on_road = {(p[0], p[1]) for p in path}
    assert all((round(s["at"]["x"]), round(s["at"]["y"])) in on_road for s in seen), seen[:3]
    assert seen[-1]["at"] != seen[0]["at"]
    last = seen[-1]
    assert abs(last["centre"]["x"] - last["at"]["x"]) <= 2 and abs(last["centre"]["y"] - last["at"]["y"]) <= 2, last
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-follow.png"))
    # A finger moving the map lets go of the camera (the figure walks on); Keep in view takes it back.
    box = pg.evaluate("() => { const r = window.__zimcity.view.canvas.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; }")
    stroke(pg, [(box["w"] / 2, box["top"] + box["h"] * 0.4 + d) for d in range(0, 120, 20)])
    pg.wait_for_selector("#cy-follow-card .cy-fw-view")
    pg.click("#cy-follow-card .cy-fw-view")
    assert pg.evaluate("() => window.__zimcity.following.cam") is True
    pg.click("#cy-follow-card .cy-news-close")
    assert pg.evaluate("() => window.__zimcity.following") is None and pg.is_hidden("#cy-follow-card")
    assert not pg.errors, pg.errors


def test_follow_someone_says_so_when_nobody_commutes_yet(browser, site):
    pg = phone(browser, site)
    pg.click(".gs-menu-btn")
    pg.click("#cy-follow")
    text = pg.wait_for_selector(OURS + " .ar-sheet-card").text_content()
    assert "Nobody commutes yet" in text and not pg.query_selector(OURS + " .cy-fw-row"), text


SAVE_KEY = "zimi.games.save.zimcity"
HOUR_MS = 3600000


def saved(pg):
    pg.evaluate("() => ZimiShell.saveNow()")
    return pg.evaluate("(k) => localStorage.getItem(k)", SAVE_KEY)


def come_back(pg, save, hours_ago=None, at=None, pace=None):
    """Put `save` back as if it was made `hours_ago` (or at the moment `at`), open the page again and wait for the
    catching up (if any) to end."""
    game = pg.url
    pg.goto(game.rsplit("/", 1)[0] + "/away-test")   # leave first: the page saves as it goes, which would stamp it now
    pg.evaluate("""([k, raw, at, pace]) => { const v = JSON.parse(raw); v.data.savedAt = at; if (pace) v.data.away = pace;
      localStorage.setItem(k, JSON.stringify(v)); }""", [SAVE_KEY, save, at if at is not None else pg.evaluate("() => Date.now()") - hours_ago * HOUR_MS, pace])
    pg.goto(game)
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
    pg.wait_for_timeout(100)
    pg.wait_for_function("() => !window.__zimcity.catching", timeout=60000)


CITY_NOW = "() => { const c = window.__zimcity.city, m = c.map; let h = 0; for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) h = (Math.imul(h, 31) + m.getTileValue(x, y)) | 0; return { t: c.sim._cityTime, funds: c.sim.budget.totalFunds, tiles: h }; }"
AWAY_CARD = OURS + " .ar-sheet-card[aria-label='While you were away']"


def test_the_same_save_away_the_same_time_becomes_the_same_city(browser, site):
    pg = phone(browser, site)
    pg.evaluate(COMMUTERS)
    save = saved(pg)
    t0 = pg.evaluate("() => window.__zimcity.city.sim._cityTime")
    at = pg.evaluate("() => Date.now()") - 30 * HOUR_MS   # 30 hours at Slow: 120 ticks, two and a half years
    runs = []
    for _ in range(2):
        come_back(pg, save, at=at)
        pg.wait_for_selector(AWAY_CARD)
        runs.append(pg.evaluate(CITY_NOW))
        pg.keyboard.press("Escape")
    assert runs[0] == runs[1], runs
    assert runs[0]["t"] - t0 == 120, (t0, runs[0])
    assert not pg.errors, pg.errors


def test_a_long_absence_stops_at_five_years_and_the_card_says_what_happened(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    pg.evaluate("""async () => { const T = await import('./zimcity-tools.js'), z = window.__zimcity, c = z.city, v = z.view, a = v.tileAt(v.w * 0.1, v.h * 0.45);
      c.sim.budget.totalFunds = 100000;
      T.build(c, 'coal', [[a.x + 2, a.y + 2]]); T.build(c, 'datacenter', [[a.x + 6, a.y + 2]]); T.build(c, 'datacenter', [[a.x + 10, a.y + 2]]); }""")
    save = saved(pg)
    t0 = pg.evaluate("() => window.__zimcity.city.sim._cityTime")
    come_back(pg, save, hours_ago=48, pace="normal")
    card = pg.wait_for_selector(AWAY_CARD)
    text = card.text_content()
    assert pg.evaluate("() => window.__zimcity.city.sim._cityTime") - t0 == 5 * 48
    assert "5 years at most" in text and "Not enough power" in text and "City report" in text, text
    if os.environ.get("SHOTS"):
        pg.screenshot(path=os.path.join(os.environ["SHOTS"], "zimcity-away.png"))
    pg.click(AWAY_CARD + " .ar-btn >> text=City report")
    pg.wait_for_selector(OURS + " .ar-sheet-card[aria-label='City report']")


def test_while_away_at_pause_the_city_waits(browser, site):
    pg = phone(browser, site)
    save = saved(pg)
    t0 = pg.evaluate("() => window.__zimcity.city.sim._cityTime")
    come_back(pg, save, hours_ago=30, pace="pause")
    assert pg.evaluate("() => window.__zimcity.city.sim._cityTime") - t0 < 4   # a frame or two of play since, not 120 ticks
    assert not pg.query_selector(AWAY_CARD)


def test_a_city_that_runs_out_of_money_while_away_waits_and_says_so(browser, site):
    pg = phone(browser, site)
    pg.evaluate(COMMUTERS)
    pg.evaluate("() => { const b = window.__zimcity.city.sim.budget; b.totalFunds = 0; b.setTax(0); }")
    save = saved(pg)
    t0 = pg.evaluate("() => window.__zimcity.city.sim._cityTime")
    come_back(pg, save, hours_ago=24 * 10)   # Slow: five years' worth, but the year's bills come first
    text = pg.wait_for_selector(AWAY_CARD).text_content()
    ran = pg.evaluate("() => window.__zimcity.city.sim._cityTime") - t0
    assert "The money ran out" in text and 0 < ran < 5 * 48, (ran, text)
    assert "City report" not in text   # Close leads to the budget
    pg.click(AWAY_CARD + " .gs-primary")
    pg.wait_for_selector(OURS + " .ar-sheet-card[aria-label='The year’s budget']")


def test_a_new_city_during_a_catch_up_is_not_stepped_by_it(browser, site):
    """New game while the old city is still catching up: the catch-up stops with its sheet, and the new city starts at
    its own beginning (the job used to keep stepping whatever city was showing)."""
    pg = phone(browser, site)
    # Five years to catch up, and New game in the same moment, before its first chunk runs.
    pg.evaluate("() => { window.__zimcity.catchUp(240, 1); document.getElementById('cy-new').click(); }")
    pg.wait_for_function("() => !window.__zimcity.catching", timeout=30000)
    pg.wait_for_timeout(1500)
    t = pg.evaluate("() => window.__zimcity.city.sim._cityTime")
    assert t < 48, t   # a new city's first moments, not years of someone else's catch-up
    assert not pg.query_selector(AWAY_CARD)
    assert not pg.errors, pg.errors


def test_a_pinch_keeps_the_place_between_the_fingers_under_them(browser, site):
    """Two fingers spread and drift: the spot of the city between them at the start ends between them at the end."""
    pg = phone(browser, site)
    # Away from the map's edges at a middling zoom, so the camera's clamp at an edge plays no part.
    pg.evaluate("() => { const v = window.__zimcity.view; v.cam.s = 1; v.centreOn(60, 50); }")
    r = pg.evaluate("() => { const c = window.__zimcity.view.canvas.getBoundingClientRect(); return { x: c.left, y: c.top, w: c.width, h: c.height }; }")
    cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
    world = "([sx, sy]) => { const c = window.__zimcity.view.cam; return [c.x + sx / c.s, c.y + sy / c.s]; }"
    a = (cx - 40, cy)
    b = (cx + 40, cy)
    before = pg.evaluate(world, [cx - r["x"], cy - r["y"]])
    touch(pg, "touchStart", [a, b])
    for i in range(1, 9):
        touch(pg, "touchMove", [(a[0] + 30 * i / 8, a[1] + 20 * i / 8), (b[0] + 90 * i / 8, b[1] + 20 * i / 8)])
        pg.wait_for_timeout(16)
    end_mid = ((a[0] + 30 + b[0] + 90) / 2, cy + 20)
    pg.wait_for_function("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))")
    after = pg.evaluate(world, [end_mid[0] - r["x"], end_mid[1] - r["y"]])
    touch(pg, "touchEnd", [])
    assert abs(after[0] - before[0]) < 0.5 and abs(after[1] - before[1]) < 0.5, (before, after)


IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"


def iphone(browser, site, height):
    ctx = browser.new_context(viewport={"width": 390, "height": height}, screen={"width": 390, "height": 844}, user_agent=IPHONE_UA,
                              device_scale_factor=3, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    pg.goto(site + "zimcity.html")
    pg.wait_for_function("() => window.__zimcity && window.__zimcity.city")
    return pg


def test_on_an_iphone_reporting_no_inset_the_tray_still_clears_the_indicator(browser, site):
    """A page that reaches the bottom of a home-indicator iPhone's screen but reads env() as 0 still keeps the tray
    34 px up; with a browser bar below the page (the window stops short of the screen) nothing is added."""
    pg = iphone(browser, site, 844)
    assert pg.evaluate(LOWEST_CONTROL) <= 844 - 34
    pg = iphone(browser, site, 664)
    assert pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--safe-b').trim()") == "0px"


MAP_ON_SCREEN = """() => { const v = window.__zimcity.view, m = v.city.map, s = v.cam.s, l = -v.cam.x * s, t = -v.cam.y * s, r = l + m.width * 16 * s, b = t + m.height * 16 * s;
  return { l, t, r, b, w: v.w, h: v.h }; }"""


def map_held(g, margin=16.5):
    """The map never leaves the screen by more than the margin; narrower (or shorter) than the screen, it is centred."""
    for lo, hi, size in (("l", "r", "w"), ("t", "b", "h")):
        span = g[hi] - g[lo]
        if span <= g[size]:
            assert abs(g[lo] - (g[size] - span) / 2) < 1, g
        else:
            assert g[lo] <= margin and g[hi] >= g[size] - margin, g


def test_pan_and_pinch_keep_the_map_on_the_screen(browser, site):
    pg = phone(browser, site)
    box = pg.evaluate("() => { const r = window.__zimcity.view.canvas.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; }")
    mid = (box["w"] / 2, box["top"] + box["h"] / 2)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        for _ in range(12):   # far past any edge
            stroke(pg, [(mid[0] + dx * k, mid[1] + dy * k) for k in range(0, 180, 30)])
        map_held(pg.evaluate(MAP_ON_SCREEN))
    # pinch all the way out, then in, then pan again
    for spread in ((160, 10), (10, 160)):
        touch(pg, "touchStart", [(mid[0] - spread[0] / 2, mid[1]), (mid[0] + spread[0] / 2, mid[1])])
        for k in range(1, 9):
            w = spread[0] + (spread[1] - spread[0]) * k / 8
            touch(pg, "touchMove", [(mid[0] - w / 2, mid[1]), (mid[0] + w / 2, mid[1])])
            pg.wait_for_timeout(16)
        touch(pg, "touchEnd", [])
        map_held(pg.evaluate(MAP_ON_SCREEN))
    for _ in range(12):
        stroke(pg, [(mid[0] + k, mid[1] + k) for k in range(0, 180, 30)])
    map_held(pg.evaluate(MAP_ON_SCREEN))
    pg.evaluate("(s) => { const v = window.__zimcity.view; v.zoomAt(v.w / 2, v.h / 2, 0.01); }", 0)
    map_held(pg.evaluate(MAP_ON_SCREEN))   # all the way out: the whole map, centred


def test_a_complaint_is_said_only_when_the_census_supports_it(browser, site):
    """An empty city with a coal plant has a high pollution "average" (it is taken over polluted tiles only): with no
    people there it says nothing. With people, and the city measured, it does."""
    pg = phone(browser, site)
    said = pg.evaluate("""async () => { const M = await import('./zimcity/engine/messages.js'), z = window.__zimcity, c = z.city, out = [];
      const ask = () => { c.sim._census.pollutionAverage = 200; c.sim._emitEvent(M.FRONT_END_MESSAGE, { subject: M.HIGH_POLLUTION }); out.push(z.said().indexOf('Pollution is very high') >= 0); };
      ask();                                           // nobody lives here
      c.sim.evaluation.cityPop = 500; ask();           // people, but the city not measured yet
      c.bornAt = c.sim._cityTime - 100; ask();         // people, measured
      return out; }""")
    assert said == [False, False, True], said


def test_a_plant_over_a_road_says_the_road_is_in_the_way(browser, site):
    """A 4 x 4 footprint centred on a finger just below a road overlaps it: the line names the road, not "Bulldoze"."""
    pg = phone(browser, site)
    box = pg.evaluate(CLEAR)
    y = box["top"] + box["h"] * 0.55
    pg.evaluate("""(y) => import('./zimcity-tools.js').then((T) => { const z = window.__zimcity, v = z.view, r = v.canvas.getBoundingClientRect(), t = v.tileAt(v.w / 2, y - r.top);
      T.build(z.city, 'road', [[t.x - 4, t.y - 1]].concat(T.steps([t.x - 4, t.y - 1], [t.x + 4, t.y - 1]))); })""", y)
    hold_more(pg, "Coal plant")
    touch(pg, "touchStart", [(box["w"] / 2, y)])
    assert pg.text_content("#cy-held") == "In the way: Road"
    touch(pg, "touchEnd", [])


def test_closing_the_menu_lets_the_city_run_again(browser, site):
    pg = phone(browser, site)
    pg.click("#cy-pause")   # running
    pg.click(".gs-menu-btn")
    assert pg.evaluate("() => document.getElementById('cy-pause').textContent.trim()") == "Resume"
    pg.keyboard.press("Escape")
    pg.wait_for_function("() => document.getElementById('cy-pause').textContent.trim() === 'Pause'", timeout=3000)


def test_brownouts_with_power_to_spare_ask_for_a_line_not_a_plant(browser, site):
    said = phone(browser, site).evaluate("""async () => { const M = await import('./zimcity/engine/messages.js'), z = window.__zimcity, c = z.city, out = [];
      c.sim._emitEvent(M.FRONT_END_MESSAGE, { subject: M.BLACKOUTS_REPORTED }); out.push(z.said().slice());
      c.shortAt = c.sim._cityTime; c.sim._emitEvent(M.FRONT_END_MESSAGE, { subject: M.BLACKOUTS_REPORTED }); out.push(z.said().slice());
      return out; }""")
    assert "Run a power line to the zones that flash" in said[0] and not any(s.startswith("Brownouts") for s in said[0]), said
    assert any(s.startswith("Brownouts") for s in said[1]), said


def test_the_away_card_starts_from_the_people_the_city_had(browser, site):
    pg = phone(browser, site)
    pg.evaluate(COMMUTERS)
    had = pg.evaluate("() => window.__zimcity.city.sim.evaluation.cityPop")
    save = saved(pg)
    come_back(pg, save, hours_ago=3)
    text = pg.wait_for_selector(AWAY_CARD).text_content()
    assert had > 0 and ("%s to" % format(had, ",")) in text, (had, text)
