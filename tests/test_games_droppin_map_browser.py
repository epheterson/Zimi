"""Drop Pin's real-map frame (droppin-frame.js): the map is only a map in the game, and where it looks is read from the map itself.

A StreetZim viewer is not in the repository, so the frame here is a stand-in with the structure a MapLibre viewer has (the container,
canvas container, control layer with zoom buttons and attribution) plus the viewer's own interface around it (search box, place chips,
a card, directions, a layer menu), a late card added after the page settled, and the map object under the name a viewer leaves on its
window (__szMap). What a real viewer's own class names are is not assumed anywhere. A real StreetZim map on a phone was not available.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_droppin_map_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames  # noqa: E402
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

VIEWER = """<!doctype html><body style="margin:0">
<div id="app">
  <div id="search"><input type="search" placeholder="Search places"></div>
  <div id="chips"><button>Restaurants</button><button>Cafes</button></div>
  <div class="maplibregl-map" id="m" style="width:300px;height:300px;position:relative">
    <div class="maplibregl-canvas-container"><canvas width="300" height="300"></canvas></div>
    <div id="inner-card" style="position:absolute;top:0">Directions to here</div>
    <div class="maplibregl-control-container">
      <div class="maplibregl-ctrl-top-right"><div class="maplibregl-ctrl-group">
        <button class="maplibregl-ctrl-zoom-in">+</button><button class="maplibregl-ctrl-zoom-out">-</button><button class="maplibregl-ctrl-compass">N</button>
      </div></div>
      <div class="maplibregl-ctrl-bottom-right"><div class="maplibregl-ctrl-attrib">OSM</div></div>
    </div>
    <div class="maplibregl-popup" id="popup">A place card</div>
  </div>
  <nav id="layers">Satellite 3D Wiki</nav>
</div>
<script>
window.__szMap = {
  f: {}, getCenter() { return { lat: 10.5, lng: 20.25 }; }, getZoom() { return 9; }, isStyleLoaded() { return true; },
  getStyle() { return { layers: [{ id: 'places', type: 'symbol', filter: ['==', ['get', 'class'], 'city'] }, { id: 'pois', type: 'symbol' }, { id: 'roads', type: 'line' }] }; },
  setFilter(id, f) { this.f[id] = f; }
};
</script></body>"""

SETUP = """(html) => {
  const f = document.createElement('iframe');
  f.id = 'stand-in'; f.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:320px;z-index:9999';
  f.srcdoc = html; document.body.appendChild(f);
  window.__ready = 0;
  window.__mode = DropPinFrame.mode(f, 'Paris', () => { window.__ready++; });
  return new Promise(r => f.addEventListener('load', () => r(true)));
}"""

HIDDEN = "(id) => { const d = document.getElementById('stand-in').contentDocument, e = d.querySelector(id); return !e || getComputedStyle(e).display === 'none'; }"


def open_page(browser, served):
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = ctx.new_page()
    page.goto("%s/droppin.html" % served)
    page.wait_for_function("() => window.DropPinFrame && window.__drop")
    return ctx, page


def test_the_map_is_only_a_map(browser, served):
    ctx, page = open_page(browser, served)
    page.evaluate(SETUP, VIEWER)
    page.wait_for_function("() => window.__ready >= 1")
    for sel in [
        "#search",
        "#chips",
        "#inner-card",
        "#popup",
        "#layers",
        ".maplibregl-ctrl-compass",
    ]:
        assert page.evaluate(HIDDEN, sel), sel + " is still shown"
    for sel in [
        "canvas",
        ".maplibregl-ctrl-zoom-in",
        ".maplibregl-ctrl-zoom-out",
        ".maplibregl-ctrl-attrib",
    ]:
        assert not page.evaluate(HIDDEN, sel), sel + " must stay"
    # A card a tap opens later is put away as it comes.
    page.evaluate(
        "() => { const d = document.getElementById('stand-in').contentDocument; const c = d.createElement('div'); c.id = 'late'; c.textContent = 'Directions to here'; d.getElementById('app').appendChild(c); const p = d.createElement('div'); p.id = 'late2'; d.getElementById('m').appendChild(p); }"
    )
    frames(page, 3)
    page.wait_for_function(
        "(sel) => { const d = document.getElementById('stand-in').contentDocument; return ['#late', '#late2'].every(s => getComputedStyle(d.querySelector(s)).display === 'none'); }",
        arg=None,
    )
    ctx.close()


def test_the_name_asked_for_comes_off_the_labels_and_comes_back_with_the_answer(
    browser, served
):
    ctx, page = open_page(browser, served)
    page.evaluate(SETUP, VIEWER)
    page.wait_for_function("() => window.__ready >= 1")
    f = page.evaluate(
        "() => document.getElementById('stand-in').contentWindow.__szMap.f"
    )
    assert set(f) == {
        "places",
        "pois",
    }, f  # label layers only; the road layer is left alone
    flat = str(f["places"])
    assert "'Paris'" in flat and "'class'" in flat and "'name:en'" in flat, f["places"]
    page.evaluate("() => window.__mode.reveal()")
    f2 = page.evaluate(
        "() => document.getElementById('stand-in').contentWindow.__szMap.f"
    )
    assert f2["pois"] is None and f2["places"] == ["==", ["get", "class"], "city"], f2
    ctx.close()


def test_where_the_map_looks_is_read_from_the_map_itself(browser, served):
    ctx, page = open_page(browser, served)
    page.evaluate(SETUP, VIEWER)
    page.wait_for_function("() => window.__ready >= 1")
    at = page.evaluate("() => DropPinFrame.centre(document.getElementById('stand-in'))")
    assert at == {
        "lat": 10.5,
        "lon": 20.25,
        "zoom": 9,
    }, at  # no #map= in the address: the old read said the map had not loaded
    # A viewer with no map object: its address, once it has written one; before that, not yet.
    page.evaluate(
        """() => { const f = document.createElement('iframe'); f.id = 'plain'; f.srcdoc = '<body>plain</body>'; document.body.appendChild(f); return new Promise(r => f.addEventListener('load', r)); }"""
    )
    assert (
        page.evaluate("() => DropPinFrame.centre(document.getElementById('plain'))")
        is None
    )
    assert page.evaluate(
        "() => { const w = document.getElementById('plain').contentWindow; w.location.hash = 'map=11/48.85/2.35'; return DropPinFrame.centre(document.getElementById('plain')); }"
    ) == {"zoom": 11, "lat": 48.85, "lon": 2.35}
    ctx.close()
PLACES = [
    ("Paris", 48.8567, 2.3508),
    ("Madrid", 40.4168, -3.7038),
    ("Rome", 41.9028, 12.4964),
    ("Berlin", 52.52, 13.405),
    ("Vienna", 48.2082, 16.3738),
]


def test_a_round_on_a_map_waits_for_the_map_not_for_a_hash(browser, served):
    """Zimi's own endpoints are answered here (the library, a random place, the map page). The map has no #map= address and says where it
    looks through its own object: Drop pin enables, the map's interface is put away, and dropping scores.
    """
    ctx = browser.new_context(
        viewport=VIEW, has_touch=True, is_mobile=True, reduced_motion="reduce"
    )
    page = ctx.new_page()
    picks = iter(PLACES * 3)

    def route(r):
        url = r.request.url
        if url.endswith("/health"):
            return r.fulfill(json={"status": "ok"})
        if "/list" in url:
            return r.fulfill(
                json=[
                    {
                        "name": "osm_test",
                        "title": "Test map",
                        "kind": "map",
                        "map_search": True,
                        "map_bounds": [-10, 35, 20, 55],
                    }
                ]
            )
        if "/random" in url:
            n, la, lo = next(picks)
            return r.fulfill(
                json={"title": n, "pos": "map=12/%s/%s" % (la, lo), "path": "x"}
            )
        if "/w/osm_test/" in url:
            return r.fulfill(body=VIEWER, content_type="text/html")
        return r.continue_()

    page.route("**/*", route)
    page.goto("%s/droppin.html" % served)
    page.wait_for_function(
        "() => window.__drop && window.__drop.g && window.__drop.g.mode === 'map'",
        timeout=30000,
    )
    src = page.get_attribute("#dp-frame", "src")
    assert (
        "map=" in src and "/w/osm_test/" in src
    ), src  # the round gives the map an address from the start
    page.wait_for_function(
        "() => !document.getElementById('dp-drop').hasAttribute('aria-disabled')",
        timeout=15000,
    )
    for sel in ["#search", "#chips", "#layers", "#popup"]:
        page.wait_for_function(
            "(s) => { const d = document.getElementById('dp-frame').contentDocument; const e = d && d.querySelector(s); return e && getComputedStyle(e).display === 'none'; }",
            arg=sel,
            timeout=10000,
        )
    page.click("#dp-drop")
    page.wait_for_function("() => window.__drop.g.ans", timeout=5000)
    assert "not loaded" not in page.inner_text("#dp-msg").lower()
    ctx.close()
