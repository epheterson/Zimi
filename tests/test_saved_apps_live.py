"""Saving in each app (1.12), in a real browser on a phone-sized screen:
ZimiTube, ZimiExchange, Reddot and Maps each save, reopen where you were,
let go, and put a thing in a list with the one picker the Saved panel uses.

- ZimiTube: Watch later, Like and Lists from the player; Continue watching
  from the time you left (an audiobook from its track); the home's rows.
- ZimiExchange and Reddot: Save, Like and Lists under the title; the Saved
  tab with the lists as chips; a long thread reopens where you were.
- Maps: Save this place names it from the map (the nearest town); Places
  lists it; tapping it flies there; its list button opens the picker.
- Each home opens with the one request it made before, whatever is kept.

The pure half is tests/test_saved_apps.cjs.

Run: pytest tests/test_saved_apps_live.py -v
"""

import os
import sys
import threading
from urllib.parse import urlsplit

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS", "")
FRAME = "document.getElementById('reader-frame')"
READY = "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0"
PHONE = {
    "viewport": {"width": 390, "height": 844},
    "has_touch": True,
    "is_mobile": True,
    "device_scale_factor": 2,
}
_VIDEO = {}


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from app_saved_fixture import build_library, webm

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("apps_saved")
    _VIDEO["webm"] = webm()
    names = build_library(tmp / "zims", _VIDEO["webm"])
    # Left pointing at this library afterwards: a background fetch still
    # running as the module ends writes under the data dir, and every other
    # test sets its own.
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(tmp / "zims"), str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], names
    httpd.shutdown()


@pytest.fixture
def phone(served):
    from playwright.sync_api import sync_playwright

    base, names = served
    errors = []
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(**PHONE)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(base + "/")
        pg.wait_for_function(READY, timeout=30000)
        pg.evaluate("() => localStorage.clear()")
        pg.reload()
        pg.wait_for_function(READY, timeout=30000)
        yield pg, names
        br.close()
    assert not errors, errors


def _in_frame(pg, js, arg=None):
    """Run js (a function of the app page's window) inside the reader frame."""
    return pg.evaluate(
        "([js, arg]) => (0, eval)('(' + js + ')')(" + FRAME + ".contentWindow, arg)",
        [js, arg],
    )


def _media(pg):
    return _in_frame(
        pg,
        "(w) => { var m = w.document.querySelector('#stage video, #stage audio'); return m ? { t: m.currentTime, ready: m.readyState } : null; }",
    )


def _wait_media(pg, at_least=0):
    pg.wait_for_function(
        "(n) => { var m = "
        + FRAME
        + ".contentDocument.querySelector('#stage video, #stage audio'); return m && m.readyState >= 1 && m.currentTime >= n; }",
        arg=at_least,
        timeout=15000,
    )


def _leave_at(pg, seconds):
    """Where you are: seek there and pause, the way a person stops."""
    _in_frame(
        pg,
        "(w, s) => { var m = w.document.querySelector('#stage video, #stage audio'); m.currentTime = s; }",
        seconds,
    )
    pg.wait_for_timeout(400)
    _in_frame(
        pg, "(w) => w.document.querySelector('#stage video, #stage audio').pause()"
    )
    pg.wait_for_timeout(300)


def _rows(pg):
    return _in_frame(
        pg,
        "(w) => Array.from(w.document.querySelectorAll('#mine .shelf')).map(s => s.querySelector('h2').textContent + ': ' + Array.from(s.querySelectorAll('.card .title')).map(t => t.textContent).join(', '))",
    )


def _picker(pg):
    pg.wait_for_selector("#zim-ctx-menu.visible")
    return pg.evaluate(
        "() => Array.from(document.querySelectorAll('#zim-ctx-menu .ctx-item')).map(i => (i.getAttribute('aria-checked') === 'true' ? '[x] ' : '') + i.textContent.replace(/^[\\u2713+]/, ''))"
    )


def _new_list(pg, name):
    pg.locator("#zim-ctx-menu .ctx-item[data-action=new-list]").click()
    pg.locator("#zim-ctx-menu .ctx-input").fill(name)
    pg.locator("#zim-ctx-menu .ctx-input").press("Enter")
    pg.wait_for_timeout(250)


def _tall(pg, sel, frame=False):
    """Every one of these is at least a thumb's height on this touch screen."""
    js = "(sel) => Array.from(document.querySelectorAll(sel)).map(e => Math.round(e.getBoundingClientRect().height))"
    hs = (
        _in_frame(
            pg,
            "(w, sel) => Array.from(w.document.querySelectorAll(sel)).map(e => Math.round(e.getBoundingClientRect().height))",
            sel,
        )
        if frame
        else pg.evaluate(js, sel)
    )
    assert hs and min(hs) >= 44, (sel, hs)


def _shot(pg, name):
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, name))


def test_zimitube_watch_later_like_lists_and_continue_watching(phone):
    pg, names = phone
    pg.evaluate("() => openTube()")
    frame = pg.frame_locator("#reader-frame")
    frame.locator(".card").first.wait_for()
    assert _in_frame(
        pg, "(w) => w.document.getElementById('mine').hidden"
    ), "nothing kept: no rows"
    video = bool(_VIDEO.get("webm"))
    # The video when this machine could make one, else the audiobook: the
    # first card is the one that plays either way.
    title = (
        "Grammar concept - Common noun Vs Proper noun"
        if video
        else "A story in two parts"
    )
    frame.locator(".card", has_text=title).first.click()
    frame.locator(".svbar .svb").first.wait_for()
    _tall(pg, ".svbar .svb", frame=True)
    frame.locator(".svb[data-sv=save]").click()
    frame.locator(".svb[data-sv=like]").click()
    item = pg.evaluate("() => Saved.itemsFor({app: 'tube'})[0]")
    assert (
        item["kind"] == "video"
        and item["title"] == title
        and item["lists"] == ["liked"]
    )
    assert (
        pg.evaluate("() => document.getElementById('library-btn').dataset.state")
        == "saved"
    ), "the header knows it is kept"
    # Lists: the panel's own picker, over the page; a new list typed in place.
    frame.locator(".svb[data-sv=lists]").click()
    assert _picker(pg) == ["[x] Liked", "New list…"]
    _new_list(pg, "Grammar")
    assert _picker(pg) == ["[x] Liked", "[x] Grammar", "New list…"]
    _tall(pg, "#zim-ctx-menu .ctx-item")
    _shot(pg, "tube_lists.png")
    frame.locator("#w-title").click()
    pg.wait_for_timeout(200)
    assert not pg.evaluate(
        "() => document.getElementById('zim-ctx-menu').classList.contains('visible')"
    ), "a tap in the page closes the picker"
    # Where you are is kept as you stop.
    _wait_media(pg)
    _leave_at(pg, 22)
    where = pg.evaluate("() => Saved.continued({app: 'tube'})[0].where")
    assert where["t"] == 22 and where["d"] == 40, where
    _in_frame(pg, "(w) => w.__back()")
    pg.wait_for_timeout(400)
    assert _rows(pg) == [
        "Continue watching: " + title,
        "Watch later: " + title,
        "Liked: " + title,
        "Lists: Grammar",
    ], _rows(pg)
    _in_frame(pg, "(w) => w.scrollTo(0, 0)")
    _shot(pg, "tube_home.png")
    # A list is a tile; tapped, the list whole, and Back to the home.
    frame.locator("#mine .card[data-list]").click()
    pg.wait_for_timeout(200)
    assert _rows(pg) == ["Grammar: " + title], _rows(pg)
    _in_frame(pg, "(w) => w.__back()")
    pg.wait_for_timeout(200)
    assert len(_rows(pg)) == 4
    # From Continue watching, it takes up where you left it.
    frame.locator("#mine .shelf[data-row=continue] .card").first.click()
    _wait_media(pg, 20)
    assert abs(_media(pg)["t"] - 22) < 2, _media(pg)
    # Let it go: out of Watch later, Liked and the list, the rows say so.
    frame.locator(".svb[data-sv=save]").click()
    assert not pg.evaluate("() => Saved.all().length")
    _in_frame(pg, "(w) => w.closePlayer()")
    pg.wait_for_timeout(400)
    assert _rows(pg) == ["Continue watching: " + title], _rows(pg)



def test_zimitube_a_long_row_shows_a_dozen_and_all_opens_it_whole(phone):
    """A row is a strip of its first dozen; All opens the row whole in the
    feed's place, and the header's arrow brings the home back."""
    pg, names = phone
    pg.evaluate(
        """(zim) => { for (var i = 0; i < 14; i++) Saved.save({ kind: 'video', app: 'tube', zim: zim, path: 'talks/' + i, title: 'Talk ' + i,
            meta: { speaker: 'Speaker ' + i, zim_title: 'English Duniya' } }); openTube(); }""",
        names["tube"],
    )
    frame = pg.frame_locator("#reader-frame")
    frame.locator("#mine .shelf[data-row=later] .card").first.wait_for()
    assert _in_frame(pg, "(w) => w.document.querySelectorAll('#mine .shelf[data-row=later] .card').length") == 12
    frame.locator("#mine .shelf[data-row=later] .all").click()
    pg.wait_for_timeout(200)
    whole = _in_frame(pg, "(w) => [w.document.querySelectorAll('#mine .grid .card').length, getComputedStyle(w.document.getElementById('list')).display, w.__top()]")
    assert whole == [14, "none", False], whole
    frame.locator("#mine .grid .card", has_text="Talk 0").click()
    frame.locator("#w-title").wait_for()
    assert _in_frame(pg, "(w) => w.document.getElementById('w-title').textContent") == "Talk 0"
    _in_frame(pg, "(w) => w.__back()")
    pg.wait_for_timeout(200)
    assert _in_frame(pg, "(w) => w.document.querySelectorAll('#mine .grid .card').length") == 14, "Back from a video returns to the row it was in"
    _in_frame(pg, "(w) => w.__back()")
    pg.wait_for_timeout(200)
    assert _in_frame(pg, "(w) => [w.document.querySelectorAll('#mine .strip .card').length > 0, getComputedStyle(w.document.getElementById('list')).display !== 'none', w.__top()]") == [True, True, True]

def test_an_audiobook_continues_at_its_track(phone):
    pg, names = phone
    pg.evaluate("() => openTube()")
    frame = pg.frame_locator("#reader-frame")
    frame.locator(".card", has_text="A story in two parts").first.click()
    frame.locator(".tracks button").nth(1).wait_for()
    frame.locator(".tracks button").nth(1).click()
    _wait_media(pg)
    _leave_at(pg, 12)
    where = pg.evaluate("() => Saved.continued({app: 'tube'})[0].where")
    assert where["k"] == 1 and where["t"] == 12 and abs(where["f"] - 0.65) < 0.01, where
    _in_frame(pg, "(w) => w.closePlayer()")
    pg.wait_for_timeout(300)
    frame.locator("#mine .shelf[data-row=continue] .card").first.click()
    _wait_media(pg, 10)
    on = _in_frame(pg, "(w) => w.document.querySelector('.tracks button.on').dataset.n")
    assert on == "1" and abs(_media(pg)["t"] - 12) < 2, (on, _media(pg))


@pytest.mark.parametrize("app", ["exchange", "reddot"])
def test_a_thread_saved_liked_listed_and_reopened_where_you_were(phone, app):
    pg, names = phone
    item_view, title = (
        ("#qview", "How can I chop onions without crying?")
        if app == "exchange"
        else ("#pview", "Zimi 1.9 is out & it is good")
    )
    pg.evaluate("() => " + ("openExchange()" if app == "exchange" else "openReddot()"))
    frame = pg.frame_locator("#reader-frame")
    frame.locator(".row .t", has_text=title).first.wait_for()
    frame.locator(".row .t", has_text=title).first.click()
    frame.locator(item_view + " .svbar .svb").first.wait_for()
    _tall(pg, item_view + " .svbar .svb", frame=True)
    frame.locator(".svb[data-sv=save]").click()
    frame.locator(".svb[data-sv=like]").click()
    frame.locator(".svb[data-sv=lists]").click()
    _new_list(pg, "Kitchen")
    assert _picker(pg) == ["[x] Liked", "[x] Kitchen", "New list…"]
    pg.evaluate("() => _closeMenu()")
    # Half way down a long thread, then away.
    _in_frame(
        pg,
        "(w) => w.scrollTo(0, (w.document.documentElement.scrollHeight - w.innerHeight) / 2)",
    )
    pg.wait_for_timeout(1200)
    kept = pg.evaluate("(a) => Saved.itemsFor({app: a})[0]", app)
    assert kept["title"] == title and sorted(kept["lists"]) == sorted(
        [
            "liked",
            pg.evaluate("() => Saved.lists().filter(l => l.name === 'Kitchen')[0].id"),
        ]
    )
    assert (
        abs(pg.evaluate("(k) => Saved.position(k).where.f", kept["key"]) - 0.5) < 0.02
    )
    _in_frame(pg, "(w) => w.__back()")
    pg.wait_for_timeout(300)
    # The Saved tab: the thing, the lists as chips, the Liked chip filters.
    frame.locator("#chips .chip", has_text="Saved").click()
    pg.wait_for_timeout(300)
    rows = _in_frame(
        pg,
        "(w) => Array.from(w.document.querySelectorAll('#l-rows .row .t')).map(t => t.textContent)",
    )
    chips = _in_frame(
        pg,
        "(w) => Array.from(w.document.querySelectorAll('#list .chips .chip.tag')).map(c => c.textContent)",
    )
    assert rows == [title] and chips == ["All 1", "Liked 1", "Kitchen 1"], (rows, chips)
    assert _in_frame(
        pg,
        "(w) => { var c = w.document.querySelector('#list .chips .chip.tag'), r = c.getBoundingClientRect(); return w.document.elementFromPoint(r.left + r.width / 2, r.top - 5) === c && w.document.elementFromPoint(r.left + r.width / 2, r.bottom + 5) === c; }",
    ), "a chip takes a tap a thumb's height tall"
    _shot(pg, app + "_saved.png")
    frame.locator("#list .chips .chip.tag", has_text="Kitchen").click()
    pg.wait_for_timeout(200)
    frame.locator("#l-rows .row .t").first.click()
    pg.wait_for_timeout(900)
    at = _in_frame(
        pg,
        "(w) => w.scrollY / (w.document.documentElement.scrollHeight - w.innerHeight)",
    )
    assert abs(at - 0.5) < 0.05, at
    # Let it go: the Saved tab goes with the last thing in it.
    frame.locator(".svb[data-sv=save]").click()
    assert not pg.evaluate("(a) => Saved.itemsFor({app: a}).length", app)
    _in_frame(pg, "(w) => w.__back()")
    pg.wait_for_timeout(300)
    assert not _in_frame(
        pg,
        "(w) => Array.from(w.document.querySelectorAll('#chips .chip')).some(c => /Saved/.test(c.textContent))",
    )


def test_maps_save_a_place_by_its_name_list_it_and_fly_back(phone):
    pg, names = phone
    pg.evaluate("() => openMaps()")
    pg.wait_for_function("() => !!_readerMap()", timeout=15000)
    assert (
        pg.evaluate(
            "() => getComputedStyle(document.getElementById('map-source-btn')).display"
        )
        != "none"
    ), "Places and maps is on a map with no other map"
    pg.evaluate("() => _readerMap().jumpTo({center: [-9.1400, 38.7215], zoom: 14})")
    pg.wait_for_timeout(600)
    pg.click("#map-source-btn")
    pg.wait_for_selector("#map-source-dropdown.visible")
    pg.locator("#map-source-dropdown [data-role=save-place]").click()
    pg.wait_for_timeout(300)
    place = pg.evaluate("() => Saved.itemsFor({app: 'maps'})[0]")
    assert (
        place["title"] == "Lisbon"
        and place["kind"] == "place"
        and place["where"]["pos"] == "map=14.00/38.72150/-9.14000"
    ), place
    rows = pg.evaluate(
        "() => Array.from(document.querySelectorAll('#map-source-dropdown .mp-place.active .mp-name')).map(n => n.textContent)"
    )
    assert rows == ["Lisbon"], rows
    assert (
        pg.evaluate(
            "() => document.querySelector('#map-source-dropdown [data-role=save-place]').getAttribute('aria-checked')"
        )
        == "true"
    )
    _tall(pg, "#map-source-dropdown .mp-row")
    _shot(pg, "maps_places.png")
    pg.evaluate("() => _closeMapSourceDropdown()")
    pg.evaluate("() => _readerMap().jumpTo({center: [-9.30, 38.60], zoom: 11})")
    pg.wait_for_timeout(600)
    pg.click("#map-source-btn")
    pg.wait_for_selector("#map-source-dropdown.visible")
    assert (
        pg.evaluate(
            "() => document.querySelector('#map-source-dropdown [data-role=save-place]').getAttribute('aria-checked')"
        )
        == "false"
    )
    pg.locator("#map-source-dropdown .mp-place .mp-name", has_text="Lisbon").click()
    pg.wait_for_timeout(800)
    assert pg.evaluate(
        "() => { var c = _readerMap().getCenter(); return [c.lat, c.lng, _readerMap().getZoom()]; }"
    ) == [38.7215, -9.14, 14]
    pg.click("#map-source-btn")
    pg.wait_for_selector("#map-source-dropdown.visible")
    pg.locator("#map-source-dropdown .mp-lists").first.click()
    assert _picker(pg) == ["Liked", "New list…"]
    _new_list(pg, "Portugal trip")
    assert _picker(pg) == ["Liked", "[x] Portugal trip", "New list…"]
    pg.evaluate("() => _closeMenu()")
    # Let it go from where it was saved.
    pg.click("#map-source-btn")
    pg.wait_for_selector("#map-source-dropdown.visible")
    pg.locator("#map-source-dropdown [data-role=save-place]").click()
    pg.wait_for_timeout(200)
    assert not pg.evaluate("() => Saved.itemsFor({app: 'maps'}).length")
    assert not pg.evaluate(
        "() => document.querySelectorAll('#map-source-dropdown .mp-place').length"
    )


def test_right_to_left_and_dark(served):
    """Hebrew, dark: the controls read right to left, the picker hangs from
    the control's own edge, the Saved tab is in Hebrew."""
    from playwright.sync_api import sync_playwright

    base, names = served
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(color_scheme="dark", **PHONE).new_page()
        pg.goto(base + "/")
        pg.wait_for_function(READY, timeout=30000)
        pg.evaluate("() => { localStorage.clear(); return setLanguage('he'); }")
        pg.wait_for_function(
            "() => document.documentElement.dir === 'rtl'", timeout=10000
        )
        pg.evaluate("() => openExchange()")
        frame = pg.frame_locator("#reader-frame")
        frame.locator(".row .t").first.wait_for()
        assert _in_frame(pg, "(w) => w.document.documentElement.dir") == "rtl"
        frame.locator(".row .t").first.click()
        frame.locator(".svb[data-sv=save]").wait_for()
        labels = _in_frame(
            pg,
            "(w) => Array.from(w.document.querySelectorAll('#qview .svb span')).map(s => s.textContent)",
        )
        assert labels == ["אהבתי", "שמירה", "רשימות"], labels
        frame.locator(".svb[data-sv=save]").click()
        frame.locator(".svb[data-sv=lists]").click()
        pg.wait_for_selector("#zim-ctx-menu.visible")
        edge = pg.evaluate(
            "() => { var f = "
            + FRAME
            + ".getBoundingClientRect(), b = "
            + FRAME
            + ".contentDocument.querySelector('.svb[data-sv=lists]').getBoundingClientRect(), m = document.getElementById('zim-ctx-menu').getBoundingClientRect(); return [Math.round(m.right), Math.round(f.left + b.right), Math.round(m.left)]; }"
        )
        # From the control's right edge, or held inside the screen's.
        assert abs(edge[0] - edge[1]) <= 1 or edge[2] == 8, edge
        order = _in_frame(pg, "(w) => Array.from(w.document.querySelectorAll('#qview .svb')).map(b => Math.round(b.getBoundingClientRect().right))")
        assert order == sorted(order, reverse=True), ("Like, Save, Lists read from the right", order)
        _shot(pg, "exchange_rtl_dark_picker.png")
        pg.evaluate("() => _closeMenu()")
        _in_frame(pg, "(w) => w.__back()")
        pg.wait_for_timeout(300)
        frame.locator("#chips .chip").first.click()
        pg.wait_for_timeout(300)
        assert (
            _in_frame(pg, "(w) => w.document.getElementById('l-title').textContent")
            == "שמורים"
        )
        assert (
            _in_frame(pg, "(w) => getComputedStyle(w.document.body).backgroundColor")
            == "rgb(23, 23, 26)"
        )
        _shot(pg, "exchange_rtl_dark_saved.png")
        br.close()


def test_an_app_home_asks_the_server_for_nothing_more(phone):
    """What is kept is drawn from the browser's store: with things saved in
    every app, each home still makes the one request it made before."""
    pg, names = phone
    pg.evaluate(
        """(n) => {
          Saved.save({ kind: 'video', app: 'tube', zim: n.tube, path: 'files/talk.webm', title: 'A talk' });
          Saved.setPosition({ kind: 'video', app: 'tube', zim: n.tube, path: 'files/talk.webm', title: 'A talk' }, { t: 30, d: 40, k: 0, f: 0.75 });
          Saved.save({ kind: 'question', app: 'exchange', zim: n.exchange, path: 'questions/1/q', title: 'A question' });
          Saved.save({ kind: 'post', app: 'reddot', zim: n.reddot, path: 'r/kiwix/x/', title: 'A post' });
        }""",
        names,
    )
    for call, first, want in [
        ("openTube()", ".card", ["/tube?limit=5000&offset=0"]),
        ("openExchange()", ".row", ["/exchange/home"]),
        ("openReddot()", ".row", ["/reddot/home"]),
    ]:
        seen = []

        def handler(r):
            if r.resource_type in ("fetch", "xhr"):
                u = urlsplit(r.url)
                seen.append(u.path + ("?" + u.query if u.query else ""))

        pg.on("request", handler)
        pg.evaluate("() => " + call)
        pg.frame_locator("#reader-frame").locator(first).first.wait_for()
        pg.wait_for_timeout(800)
        pg.remove_listener("request", handler)
        assert seen == want, (call, seen)
        assert _in_frame(
            pg, "(w) => /Saved|Watch later/.test(w.document.body.innerText)"
        ), call
        pg.evaluate("() => closeReader()")
        pg.wait_for_timeout(200)
