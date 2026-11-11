"""Every control on a phone's first screens has a hit area a finger can find, and the count of ones that do not only goes down.

Eric: "enlarge the touch area only": the look and the layout stay, the box a tap lands on grows to 44x44 CSS px (an
invisible ::after, app.css's coarse-pointer block). tests/hit_probe.js walks the screen's buttons, links, inputs and
[onclick] elements at 390 px and finds where a tap really lands on each (elementFromPoint, so a hit box counts and one a
neighbour covers does not). A screen may keep at most FLOORS[screen] controls under 44x44: what is left is a control that
cannot grow without moving pixels (the search box is 40 tall, the three buttons at the bar's end are 6px apart, a menu's
rows are stacked, a date's parts are the Almanac's editor).

Run: pytest tests/test_touch_areas_live.py -v
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from test_home_apps_live import HOME, LIBRARY  # noqa: E402

pytestmark = pytest.mark.fieldguide_on
DAY = 86400
PROBE = "\n".join(
    line
    for line in open(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "hit_probe.js"),
        encoding="utf-8",
    )
    .read()
    .splitlines()
    if not line.startswith("//")
)
# screen: (library view, what to do first, most controls allowed under 44x44)
SCREENS = {
    "home-list": ("list", "", 3),
    "home-tiles": ("tiles", "", 2),
    "reader": ("list", "openArticle('water', 'A/Water_purification', 'Water')", 1),
    "manage": ("list", "toggleManage()", 12),
    "tube": ("list", "openTube()", 1),
}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("touch")
    zdir = tmp / "zims"
    zdir.mkdir()
    for filename, meta, _ in LIBRARY:
        build_fixture_zim(str(zdir / filename), meta)
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setenv("ZIMI_OFFLINE", "1")
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    srv.load_cache(force=True)
    now = time.time()
    by_file = {srv._zim_short_name(f): when for f, _, when in LIBRARY}
    for z in srv._zim_list_cache:
        if z["name"] in by_file:
            days, hours, entries = by_file[z["name"]]
            z["first_seen"] = now - days * DAY
            z["updated_at"] = now - hours * 3600 if hours else None
            z["entries"] = entries
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


@pytest.mark.parametrize("screen", sorted(SCREENS))
def test_a_finger_finds_every_control_it_can(served, screen):
    from playwright.sync_api import sync_playwright

    view, act, floor = SCREENS[screen]
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={
                "width": 390,
                "height": 3000 if screen.startswith("home") else 844,
            },
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script("localStorage.setItem('zimi_library_view','%s');" % view)
        pg = ctx.new_page()
        try:
            pg.goto(served + "/")
            pg.wait_for_function(HOME, timeout=30000)
            pg.wait_for_timeout(600)
            if act:
                pg.evaluate("() => { %s; }" % act)
                pg.wait_for_timeout(2500)
            got = pg.evaluate(PROBE)
            assert got["total"] >= 7, got
            assert (
                got["small"] <= floor
            ), "%s: %d controls under 44x44 (floor %d): %s" % (
                screen,
                got["small"],
                floor,
                got["list"],
            )
            # The ⋯ on a Home tile is never one of them.
            assert not [
                x for x in got["list"] if "card-more" in x or "dc-more" in x
            ], got["list"]
        finally:
            br.close()
