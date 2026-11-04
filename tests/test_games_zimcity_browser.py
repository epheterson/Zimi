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
