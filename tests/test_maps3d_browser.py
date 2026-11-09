"""A map for any place, and the installed map's roads and names on the 3D Earth.

Eric, 2026-11-09: a map for any place from every view (open the installed map that holds it, or offer the right one to
download), and maps in the 3D world (as the camera comes down, the map's streets and place names appear on the globe;
where no map holds what is looked at, a quiet hint to get one).

The library here has a Kiwix-shaped map of France and its neighbours, made in this file: real Mapbox Vector Tiles with a
``transportation`` layer (roads in four classes) and a ``place`` layer (Paris and towns), at every zoom the camera can
ask for round Paris. In headless Chromium at a phone's size:
  - the place card of Paris carries a map button that opens that map there, and one of Tokyo (no map here) offers the
    maps worth downloading, from the catalogs Zimi ships;
  - Go to's found rows carry the same button;
  - low over Paris the roads and names are laid on the globe (a screenshot, read by eye), and far out they are gone;
  - low over Tokyo, with no map there, the chip offers the map to get and nothing is drawn.

Run: scripts/../heavy.sh pytest tests/test_maps3d_browser.py -v   (browser tests share two slots across lanes)
"""

import json
import os
import sys
import threading

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import GL_ARGS, PARIS, _open  # noqa: E402
from test_mapplaces import (
    EXTENT,
    _field,
    _tile_xy,
    _uint_field,
    _varint,
    _zigzag,
)  # noqa: E402
from test_place_autocomplete import _place_layer  # noqa: E402

NAME = "maps_en_demo_2026-06"
MAP = "maps_en_demo"
BOUNDS = [[-5.0, 41.0], [10.0, 52.0]]
TOKYO = (35.68, 139.69)
Z_RANGE = range(2, 13)
AROUND = 3  # tiles each side of Paris's, at every zoom
SHOTS = os.environ.get("MAPS3D_SHOTS", "")  # a folder to keep the screenshots in
TOWNS = [
    ("city", {"name": "Paris", "rank": 1, "capital": 2}, PARIS),
    ("town", {"name": "Versailles"}, (48.804, 2.134)),
    ("town", {"name": "Saint-Denis"}, (48.936, 2.357)),
    ("town", {"name": "Meaux"}, (48.96, 2.88)),
    ("town", {"name": "Melun"}, (48.54, 2.66)),
    ("city", {"name": "Orléans", "rank": 4}, (47.90, 1.909)),
    ("city", {"name": "Reims", "rank": 5}, (49.258, 4.032)),
]


def _road_layer(z):
    """A ``transportation`` layer: a motorway across the middle, a primary down it, more as the zoom allows."""
    keys, values, feats = ["class"], [], []
    lines = [("motorway", (0, 0.5), (1, 0.5)), ("primary", (0.5, 0), (0.5, 1))]
    if z >= 7:
        lines += [("secondary", (0, 0.2), (1, 0.8)), ("secondary", (0.2, 0), (0.8, 1))]
    if z >= 9:
        lines += [
            ("tertiary", (0, 0.75), (1, 0.75)),
            ("minor", (0.25, 0), (0.25, 1)),
            ("minor", (0.75, 0), (0.75, 1)),
        ]
    for cls, a, b in lines:
        values.append(_field(1, cls.encode()))
        ax, ay = round(a[0] * EXTENT), round(a[1] * EXTENT)
        bx, by = round(b[0] * EXTENT), round(b[1] * EXTENT)
        geom = [
            1 | (1 << 3),
            _zigzag(ax),
            _zigzag(ay),
            2 | (1 << 3),
            _zigzag(bx - ax),
            _zigzag(by - ay),
        ]
        feats.append(
            _field(2, b"".join(_varint(t) for t in (0, len(values) - 1)))
            + _uint_field(3, 2)
            + _field(4, b"".join(_varint(g) for g in geom))
        )
    layer = _uint_field(15, 2) + _field(1, b"transportation")
    layer += b"".join(_field(2, f) for f in feats)
    layer += b"".join(_field(3, k.encode()) for k in keys)
    layer += b"".join(_field(4, v) for v in values)
    layer += _uint_field(5, EXTENT)
    return _field(3, layer)


def _map_files():
    files = {
        "content/config.json": json.dumps(
            {"boundingBox": BOUNDS, "maxzoom": 12}
        ).encode()
    }
    for z in Z_RANGE:
        cx, cy, _fx, _fy = _tile_xy(z, *PARIS)
        n = 2**z
        for x in range(cx - AROUND, cx + AROUND + 1):
            for y in range(cy - AROUND, cy + AROUND + 1):
                if not (0 <= x < n and 0 <= y < n):
                    continue
                here = [t for t in TOWNS if _tile_xy(z, *t[2])[:2] == (x, y)]
                files[f"tiles/{z}/{x}/{y}.pbf"] = _road_layer(z) + (
                    _place_layer(z, here) if here else b""
                )
    return files


def _serve(root):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = root / "zims"
    zdir.mkdir()
    (root / "data").mkdir()
    import wiki_fixture
    from conftest_zim import build_fixture_zim

    wiki_fixture.build_library(str(zdir))
    build_fixture_zim(
        str(zdir / f"{NAME}.zim"),
        {"Scraper": "maps2zim v0.2.1"},
        files=_map_files(),
        main_path="content/config.json",
    )
    saved = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(root / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, saved


@pytest.fixture(scope="module")
def maplib(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    import zimi.server as srv

    httpd, saved = _serve(tmp_path_factory.mktemp("maps3d_lib"))
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved
    env.undo()


def test_map_for_answers_with_the_installed_map_of_paris_and_offers_for_tokyo(maplib):
    import urllib.request

    get = lambda lat, lng: json.load(
        urllib.request.urlopen(f"{maplib}/map-for?lat={lat}&lng={lng}")
    )  # noqa: E731
    paris = get(*PARIS)
    assert [m["name"] for m in paris["installed"]] == [MAP]
    assert paris["offers"] == []
    tokyo = get(*TOKYO)
    assert tokyo["installed"] == []
    assert tokyo["offers"] and all(o["download_url"] for o in tokyo["offers"])


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name))


# Stands the camera over a place at a distance from the Earth's middle, drawn once.
PICK = "([lat, lon]) => _aePlacePick({ name: 'Spot', label: 'Spot', lat: lat, lon: lon, kind: 'town' })"
SET_DIST = "d => { _ae.dist = d; _ae.dirty = true; _aeKick(); }"


def _go_low(pg, lat, lon, dist):
    """Fly over the place (the camera must have arrived, or it looks at where it was), then to the distance."""
    pg.evaluate(PICK, [lat, lon])
    pg.wait_for_function("() => !_ae.fly", timeout=60_000, polling=200)
    pg.evaluate(SET_DIST, dist)


# Open Paris's place card with the link stand-in recording what is opened.
STAND_IN = "() => { window.__opened = null; AlmanacLinks.openHit = function (h, o) { window.__opened = { hit: h, opts: o }; }; }"


def _settled(pg, ready=3):
    pg.wait_for_function(
        "n => window.AlmanacMaps && Object.values(AlmanacMaps._tiles()).filter(t => t.mesh && t.mesh.visible).length >= n",
        arg=ready,
        timeout=120_000,
        polling=300,
    )


def test_the_place_card_opens_the_installed_map_or_offers_one_to_get(maplib):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, maplib)
            pg.evaluate(STAND_IN)
            pg.evaluate(
                "p => _aePlacePick({ name: 'Paris', label: 'Paris', lat: p[0], lon: p[1], kind: 'town' })",
                list(PARIS),
            )
            pg.wait_for_selector(".ae-card-map:not([hidden])", timeout=60_000)
            pg.click(".ae-card-map")
            pg.wait_for_function("() => !!window.__opened", timeout=30_000)
            opened = pg.evaluate("window.__opened")
            assert opened["hit"]["zim"] == MAP
            assert (
                opened["opts"]["pos"].startswith("12/48.85")
                or "48.85" in opened["opts"]["pos"]
            ), opened
            # Tokyo: no map of it here; the maps worth getting are offered, smallest region first.
            pg.evaluate(
                "p => _aePlacePick({ name: 'Tokyo', label: 'Tokyo', lat: p[0], lon: p[1], kind: 'town' })",
                list(TOKYO),
            )
            pg.wait_for_selector(".ae-card-map:not([hidden])", timeout=60_000)
            pg.click(".ae-card-map")
            pg.wait_for_selector("#mh-sheet .mh-row", timeout=30_000)
            rows = pg.evaluate(
                "Array.from(document.querySelectorAll('#mh-sheet .mh-row')).map(r => r.textContent)"
            )
            assert 1 <= len(rows) <= 4 and any(
                "Japan" in r or "Asia" in r or "World" in r or "Planet" in r
                for r in rows
            ), rows
            _shot(pg, "tokyo-offers.png")
            pg.keyboard.press("Escape")
            assert pg.evaluate("!document.getElementById('mh-sheet')")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_go_to_rows_carry_the_map_button(maplib):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, maplib)
            pg.evaluate(STAND_IN)
            pg.click("#ae-go-btn")
            pg.wait_for_selector("#ae-go-q", state="visible")
            pg.fill("#ae-go-q", "Versailles")
            pg.wait_for_selector("#ae-go-found .ae-go-map", timeout=60_000)
            pg.click("#ae-go-found .ae-go-map")
            pg.wait_for_function("() => !!window.__opened", timeout=30_000)
            assert pg.evaluate("window.__opened.hit.zim") == MAP
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_low_over_a_map_its_roads_and_names_are_on_the_globe_and_far_out_they_are_not(
    maplib,
):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, maplib)
            _go_low(pg, PARIS[0], PARIS[1], 1.12)
            _settled(pg)
            pg.wait_for_timeout(1500)
            assert pg.evaluate("AlmanacMaps._map().name") == MAP
            _shot(pg, "paris-1.12.png")
            # Nearer: over the map the camera may come down to its own limit.
            _go_low(pg, PARIS[0], PARIS[1], 1.01)
            pg.wait_for_function("() => _ae.dist < 1.05", timeout=30_000)
            pg.wait_for_timeout(3000)
            _shot(pg, "paris-1.01.png")
            low = pg.evaluate("_aeMapsMin()")
            assert low < 1.05, low
            # The frame's cost with the map on.
            cost = pg.evaluate(
                "() => { var S = _ae.gl, t0 = performance.now(); for (var i = 0; i < 60; i++) AlmanacMaps.frame(S); return (performance.now() - t0) / 60; }"
            )
            assert cost < 2.0, cost
            # Far out: nothing of the map is drawn, nothing is asked for.
            _go_low(pg, PARIS[0], PARIS[1], 6)
            pg.wait_for_timeout(1500)
            assert pg.evaluate(
                "Object.values(AlmanacMaps._tiles()).every(t => !t.mesh || !t.mesh.visible || t.mat.uniforms.opacity.value === 0)"
            )
            _shot(pg, "paris-far.png")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_low_over_ground_no_installed_map_holds_a_quiet_chip_offers_the_map_to_get(
    maplib,
):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, maplib)
            _go_low(pg, TOKYO[0], TOKYO[1], 1.1)
            pg.wait_for_selector(
                "#ae-maps-chip:not([hidden]) .ae-maps-act", timeout=120_000
            )
            text = pg.inner_text("#ae-maps-chip")
            assert "MB" in text or "GB" in text, text
            assert pg.evaluate("Object.values(AlmanacMaps._tiles()).length") == 0
            _shot(pg, "tokyo-chip.png")
            pg.click("#ae-maps-chip .ae-maps-act")
            pg.wait_for_selector("#mh-sheet .mh-row", timeout=30_000)
            pg.keyboard.press("Escape")
            # Put away with its cross: it stays away from there.
            pg.click("#ae-maps-chip .ae-maps-x")
            assert pg.evaluate("document.getElementById('ae-maps-chip').hidden")
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
