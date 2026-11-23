"""The 3D view's controls keep one contract in every mode.

One browser walks a fixed tour at 390 x 844 with touch (the orbit view, a body with a card, the planets, side by side,
the UFO, standing, driving, a landing site, a mission, the launch pad) and again on its side, and reads what is on
screen at each stop (zimi/static/almanac-earth.js, _aeHudProbe), with the time chip shut and open. Each rule below is
then checked at every stop, so a control that is right in the orbit view and wrong in a mission fails here by name.

A stop that is known to break a rule today is listed in KNOWN with the reason; the list only ever gets shorter.
The tour's pictures are written to test-results/shots/hud/contract/ with one sheet of them all.

Run: pytest tests/test_almanac_hud_contract_browser.py -v
"""

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from test_almanac_go_sheet_browser import _open  # noqa: E402
from test_almanac_places_browser import GL_ARGS, library  # noqa: E402,F401

pytestmark = pytest.mark.timeout(
    2400
)  # the tour is one long walk: the first test pays for all of it

PORTRAIT = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}
# One folder per xdist worker: each worker walks the whole tour for its own tests, and two walks writing and reading
# one folder left the contact sheet reading a half-written picture.
SHOTS = os.path.join(
    ROOT, "test-results", "shots", "hud", "contract" + os.environ.get("PYTEST_XDIST_WORKER", "")
)
STEP_MS = 540_000
SETTLE_MS = 700
FADE_MS = 20_000
OVERLAP_PX = 2  # two boxes share more than this each way: they overlap
IN_CAPSULE = (
    "ae-back",
    "ae-fly-btn",
)  # the two circles that stand inside the open time capsule
EDGE_PX = 70  # "top left": within this of both edges
SHEET_W = 260
EDGE_LAYERS = ("ae-lm-btn", "ae-orbits-btn")  # the two layer buttons that stand over the locate button

# Every stop of the tour, in order: (name, the mode it must read as). Landscape walks the stops that cost nothing to reach.
STOPS = (
    ("orbit", "orbit"),
    ("card", "orbit"),
    ("planets", "system"),
    ("sbs", "sbs"),
    ("ufo", "ufo"),
    ("stand", "stand"),
    ("drive", "drive"),
    ("site", "site"),
    ("mission", "mission"),
    ("pad", "pad"),
)
WIDE = ("orbit", "card", "planets", "sbs", "ufo")
ALL = [n for n, _ in STOPS] + ["wide-" + n for n in WIDE]
# The modes a person leaves and comes back to the orbit view from.
RETURNS = ("ufo", "stand", "drive", "site", "mission", "pad")
# Where the UFO button is promised: there, there and lit, or not there (always, anywhere; the pad's strip is its own).
UFO = {
    "orbit": "off",
    "card": "off",
    "planets": "off",
    "sbs": "off",
    "ufo": "on",
    "stand": "off",
    "drive": "off",
    "site": "off",
    "mission": "off",
    "pad": None,
}
# Stops where search stands in its corner (bottom left): everywhere but the pad, whose foot is its own strip and
# transport and whose way out is one step back to where search is. TRACK_STOPS: the stops with the worlds' track beside it.
TRACK_STOPS = ("orbit", "card", "planets", "sbs", "ufo")
GROUND = ("stand", "drive", "site", "mission")
FIND = TRACK_STOPS + GROUND
FIND_PX = 44
INSET_PX = 12
TRACK_GAP_PX = 2  # a world's seen part comes no nearer search than this
# The worlds' track run from end to end: any world whose seen part touches search, and any point of search a finger
# would not reach.
TRACK = """(gap) => { var c = document.getElementById('ae-chips'), f = document.getElementById('ae-find'), view = _ae.el;
  if (!c || !f || f.hidden) return null;
  var fr = f.getBoundingClientRect(), was = [c.scrollLeft, c.scrollTop], hits = [], seen = 0;
  [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
    c.scrollLeft = t * (c.scrollWidth - c.clientWidth); c.scrollTop = t * (c.scrollHeight - c.clientHeight);
    Array.prototype.forEach.call(c.querySelectorAll('[data-ae-view]'), function (d) {
      var b = _ahSeenBox(d, view);
      if (b) seen++;
      if (b && b.l < fr.right + gap && b.r > fr.left - gap && b.t < fr.bottom + gap && b.b > fr.top - gap) hits.push([t, d.getAttribute('data-ae-view')]);
    });
    [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85]].forEach(function (p) {
      var e = document.elementFromPoint(fr.left + p[0] * fr.width, fr.top + p[1] * fr.height);
      if (e !== f && !f.contains(e)) hits.push([t, 'covered by ' + (e && (e.id || e.className))]);
    });
  });
  c.scrollLeft = was[0]; c.scrollTop = was[1];
  return { hits: hits, seen: seen }; }"""

# What is known to break a rule today: {rule: {stop: why}}. Each fix takes its lines out.
KNOWN = {}

ENTER = {
    "orbit": ("() => {}", "() => !_ae.fly && _ae.target === 'earth'"),
    "card": ("() => _aePreset('mars')", "() => !_ae.fly && _ae.target === 'mars'"),
    "planets": (
        "() => _aePreset('planets')",
        "() => !_ae.fly && _ae.preset === 'planets'",
    ),
    "sbs": ("() => _aeGoPick(AE_SPIN_KEY)", "() => !!_ae.spin"),
    "ufo": ("() => _aeFlyToggle()", "() => !!_ae.ship"),
    "stand": (
        "() => _aeStandAt('earth', 34.05, -118.24)",
        "() => !!(_ae.stand && _ae.stand.mode !== 'descend')",
    ),
    "drive": (
        "() => _aeDriveHere('mars', 10, 20)",
        "() => { var b = document.getElementById('as-menu-btn'); return !!(_ae.site && _ae.site.drive && _ae.site.host && b && b.offsetParent); }",
    ),
    "site": (
        """() => new Promise((done) => { (function go() {
             if (typeof _aeSiteVisit === 'function' && typeof _asData !== 'undefined' && _asData && _aeLm.moon) {
               _aeSiteVisit('moon', _aeLm.moon.filter((r) => r[0] === 'Apollo 11')[0], false); done(); } else setTimeout(go, 200); })();
             if (typeof _aeSitesLoad === 'function') _aeSitesLoad(); })""",
        "() => { var s = typeof _aeSiteState === 'function' && _aeSiteState(); return !!(s && s.phase === 'stand' && s.ready); }",
    ),
    "mission": (
        "() => _aeMissionStart('apollo11')",
        "() => !!_ae.mission && !!document.getElementById('am-hud')",
    ),
    "pad": (
        "() => _aePadOpen('apollo11')",
        "() => typeof _pv !== 'undefined' && !!_pv && !!_pv.ready",
    ),
}
# The way back to the orbit view over the Earth from each stop.
LEAVE = {
    "card": "() => { _aeCardClear(); _aePreset('earth'); }",
    "planets": "() => _aePreset('earth')",
    "sbs": "() => _aePreset('earth')",
    "ufo": "() => _afStop()",
    "stand": "() => _aeStandLeave()",
    "drive": "() => { _aeSiteLeave(); _aePreset('earth'); }",
    "site": "() => { _aeSiteLeave(); _aePreset('earth'); }",
    "mission": "() => { _amStop(false); _aePreset('earth'); }",
    "pad": "() => { _pvBack(); if (_ae.mission) _amStop(false); _aePreset('earth'); }",
}
HOME = "() => !_ae.fly && !_ae.spin && !_ae.ship && !_ae.stand && !_ae.standPending && !_ae.site && !_ae.mission && !_ae.hand && _ae.target === 'earth' && _ae.preset !== 'planets'"
PROBE = "() => _aeHudProbe()"
SHOWN = "() => parseFloat(getComputedStyle(document.getElementById('ae-back')).opacity) > 0.99 && !_ae.el.classList.contains('ae-bare')"
# A spot on the open capsule's glass where nothing of its own stands: a tap there shuts it.
FACE = """() => { var pin = document.getElementById('ae-pin'), r = pin.getBoundingClientRect();
  for (var y = r.bottom - 4; y > r.top; y -= 4) for (var x = r.left + 6; x < r.right; x += 6) {
    var t = document.elementFromPoint(x, y);
    if (t && pin.contains(t) && !t.closest('.alm-ck-now, .alm-spd, .alm-ck-pop, .ep, button, input')) return [x, y]; }
  return [r.left + 6, r.bottom - 4]; }"""
LIVE = "() => !_almClockAway() && _almRate === 1"
# The four corners: where each stands (from the left or right edge, from the top or bottom edge), in every mode it is in.
CORNERS = {
    "ae-back": ("left", "top"),
    "ae-fly-btn": ("right", "top"),
    "ae-find": ("left", "bottom"),
    "ae-rim": ("right", "bottom"),
    "ae-sbs": ("right", "bottom"),
}
TOP_PX = 8
HERO_PX = 44
MINOR_PX = 44
# A finger's tap that goes no further than saying who took it: armed before a real tap, read after it.
ARM = """() => { window.__ahTap = null; window.__ahArm = function (e) { var b = e.target.closest ? e.target.closest('button') : null;
  window.__ahTap = (b || e.target).id || (e.target.className && String(e.target.className)) || e.target.tagName; e.preventDefault(); e.stopImmediatePropagation(); };
  document.addEventListener('click', window.__ahArm, true); }"""
TOOK = "() => { document.removeEventListener('click', window.__ahArm, true); return window.__ahTap; }"


def _probe(pg):
    try:  # a move between modes fades the controls out and in: read them once they are back
        pg.wait_for_function(SHOWN, timeout=FADE_MS, polling=100)
    except Exception as e:  # still faded: the reading says so itself (no controls), and the rules fail by name
        print("controls not shown after %d ms: %s" % (FADE_MS, str(e).splitlines()[0]))
    pg.wait_for_timeout(SETTLE_MS)
    return pg.evaluate(PROBE)


def _chip(snap):
    """The time chip, shut: the place a finger opens it."""
    for c in snap["controls"]:
        if c["id"] == "ae-clock":
            return c
    return None


SHOT_MS = 120_000


def _shot(pg, path):
    """A picture for a person to look over. Nothing in the contract reads it, so a renderer too slow to hand a frame over
    (software GL on a shared runner) costs the picture, never the tour."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    try:
        pg.screenshot(path=path, timeout=SHOT_MS, animations="disabled")
    except PlaywrightTimeout:
        pass


def _stop(pg, name, shots, prefix=""):
    """Read one stop shut, tap the chip the way a finger does, read it open, and tap it shut again."""
    shut = _probe(pg)
    _shot(pg, os.path.join(shots, prefix + name + ".png"))
    out = {
        "shut": shut,
        "open": None,
        "opens": False,
        "closes": False,
        "track": pg.evaluate(TRACK, TRACK_GAP_PX),
        "taps": {},
    }
    for c in shut["controls"]:  # each corner, tapped the way a finger does
        if c["rank"] == "hero":
            pg.evaluate(ARM)
            pg.touchscreen.tap(
                c["box"][0] + c["box"][2] / 2, c["box"][1] + c["box"][3] / 2
            )
            pg.wait_for_timeout(120)
            out["taps"][c["id"]] = pg.evaluate(TOOK)
    chip = _chip(shut)
    if chip:
        x, y = chip["box"][0] + chip["box"][2] / 2, chip["box"][1] + chip["box"][3] / 2
        pg.touchscreen.tap(x, y)
        opened = _probe(pg)
        out["opens"] = opened["pillOpen"]
        if opened["pillOpen"]:
            out["open"] = opened
            _shot(pg, os.path.join(shots, prefix + name + "-open.png"))
            spot = pg.evaluate(
                FACE
            )  # the capsule's own face, clear of its date, slider and where line
            pg.touchscreen.tap(spot[0], spot[1])
            out["closes"] = not _probe(pg)["pillOpen"]
            pg.evaluate("() => _aePinSet(false)")
    return out


def _walk(pg, names, shots, prefix=""):
    snaps = {}
    home = None
    for name in names:
        go, there = ENTER[name]
        pg.evaluate(go)
        pg.wait_for_function(there, timeout=STEP_MS, polling=250)
        if name == "card":  # a tap on the planet's face: a card for a thing there, or the info corner fixed on the spot
            pg.wait_for_timeout(SETTLE_MS)
            view = pg.viewport_size
            pg.touchscreen.tap(
                view["width"] / 2,
                view["height"] / 2 - (0 if view["width"] > view["height"] else 60),
            )
            pg.wait_for_function(
                "() => { var c = document.getElementById('ae-card'); return (!!c && !c.hidden) || !!_ae.pick; }",
                timeout=20_000,
            )
        snaps[prefix + name] = snap = _stop(pg, name, shots, prefix)
        if name == "orbit":
            home = {"snap": snap["shut"], "live": pg.evaluate(LIVE)}
        if name in LEAVE:
            pg.evaluate(LEAVE[name])
            pg.wait_for_function(HOME, timeout=STEP_MS, polling=250)
            if name == "sbs":
                # The stop's tap on the clock chip is a person's own speed: leaving Side by side leaves the date where it ran to
                # (see _ae.spin.autoRun), so the clock is put back to now before the stops that check it comes back as it was.
                pg.evaluate("() => { _almClockSetRate(1); _aeNow(); }")
            pg.wait_for_timeout(SETTLE_MS)
            pg.evaluate(
                "() => { var c = document.getElementById('ae-card'); if (c && !c.hidden) _aeCardClear(); }"
            )
            snap["after"] = {"snap": _probe(pg), "live": pg.evaluate(LIVE)}
            _shot(pg, os.path.join(shots, prefix + name + "-after.png"))
    snaps[prefix + "home"] = home
    return snaps


def _sheet(shots):
    """One picture of the whole tour, for a person to look over."""
    try:
        from PIL import Image
    except ImportError:
        return
    files = sorted(
        f for f in os.listdir(shots) if f.endswith(".png") and f != "sheet.png"
    )
    tiles = []
    for f in files:
        im = Image.open(os.path.join(shots, f)).convert("RGB")
        tiles.append(im.resize((SHEET_W, round(im.height * SHEET_W / im.width))))
    if not tiles:
        return
    per = 8
    rows = [tiles[i : i + per] for i in range(0, len(tiles), per)]
    height = sum(max(t.height for t in r) + 4 for r in rows)
    sheet = Image.new("RGB", (per * (SHEET_W + 4), height), (40, 0, 40))
    y = 0
    for r in rows:
        for i, t in enumerate(r):
            sheet.paste(t, (i * (SHEET_W + 4), y))
        y += max(t.height for t in r) + 4
    sheet.save(os.path.join(shots, "sheet.png"))


@pytest.fixture(scope="module")
def tour(library):  # noqa: F811
    from playwright.sync_api import sync_playwright

    os.makedirs(SHOTS, exist_ok=True)
    snaps = {}
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT, "dark")
            snaps.update(_walk(pg, [n for n, _ in STOPS], SHOTS))
            snaps["errors"] = list(errors)
            ctx.close()
            ctx, pg, errors = _open(br, library, LANDSCAPE, "dark")
            snaps.update(_walk(pg, WIDE, SHOTS, "wide-"))
            snaps["errors"] += list(errors)
            ctx.close()
        finally:
            br.close()
    _sheet(SHOTS)
    with open(
        os.path.join(SHOTS, "tour.json"), "w"
    ) as fh:  # what was read at each stop, beside its picture
        json.dump(snaps, fh, indent=1)
    return snaps


def _cases(rule, names=ALL):
    """One case per stop; a stop known to break this rule is expected to, strictly (a fix must take its line out)."""
    known = KNOWN.get(rule, {})
    return [
        (
            pytest.param(n, marks=pytest.mark.xfail(strict=True, reason=known[n]))
            if n in known
            else n
        )
        for n in names
    ]


def _both(tour, stop):
    s = tour[stop]
    return [("shut", s["shut"])] + ([("open", s["open"])] if s["open"] else [])


def _chrome(snap):
    """The layer's own controls and words: the shut chip as one thing, never the open capsule's own parts (the page's
    clock), nor a card's or a dock's own things."""
    return [
        c
        for c in snap["controls"]
        if not c["inDock"] and (not c["inPill"] or c["id"] == "ae-clock")
    ]


def _over(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return w > OVERLAP_PX and h > OVERLAP_PX


def test_the_tour_runs_without_a_page_error(tour):
    assert not tour["errors"], tour["errors"]


@pytest.mark.parametrize("stop", _cases("mode"))
def test_each_stop_reads_as_its_one_mode(tour, stop):
    want = dict(STOPS)[stop.replace("wide-", "")]
    assert tour[stop]["shut"]["mode"] == want, tour[stop]["shut"]["mode"]


@pytest.mark.parametrize("stop", _cases("pill"))
def test_the_time_chip_opens_on_a_tap_and_shuts_on_the_next(tour, stop):
    s = tour[stop]
    assert _chip(s["shut"]), "no time chip at this stop"
    assert s["opens"], "a tap on the chip did not open it"
    assert s["closes"], "a tap on the open chip's face did not shut it"
    assert not [c for c in s["open"]["controls"] if c["id"] == "ae-where"], (
        "open, the capsule is the time alone: where is the info corner's"
    )


@pytest.mark.parametrize("stop", _cases("overlap"))
def test_no_two_controls_overlap(tour, stop):
    hits = []
    for state, snap in _both(tour, stop):
        cs = _chrome(snap)
        for i, a in enumerate(cs):
            for b in cs[i + 1 :]:
                if a["inRow"] and b["inRow"]:
                    continue  # the track's own worlds (a moon is joined to its planet)
                if _over(a["box"], b["box"]):
                    hits.append((state, a["id"], b["id"]))
        for c in (
            cs if snap["pill"] else []
        ):  # only the two circles the open capsule holds stand on its glass
            if c["id"] not in IN_CAPSULE and _over(snap["pill"], c["box"]):
                hits.append((state, "the open capsule", c["id"]))
    assert not hits, hits


@pytest.mark.parametrize("stop", _cases("top"))
def test_every_control_takes_its_own_tap(tour, stop):
    under = [
        (state, c["id"], c["top"])
        for state, snap in _both(tour, stop)
        for c in snap["controls"]
        if c["kind"] == "tap"
        and c["top"]
        and (not c["inPill"] or c["id"] == "ae-clock")
    ]
    assert not under, under


@pytest.mark.parametrize("stop", _cases("out"))
def test_there_is_one_way_out_and_it_is_top_left(tour, stop):
    for state, snap in _both(tour, stop):
        outs = [c for c in snap["controls"] if c["out"]]
        assert len(outs) == 1, (state, [c["id"] for c in outs])
        box = outs[0]["box"]
        assert box[0] < EDGE_PX and box[1] < EDGE_PX, (state, outs[0]["id"], box)


@pytest.mark.parametrize("stop", _cases("disc"))
def test_every_round_control_stands_on_its_disc(tour, stop):
    bare = [
        (state, c["id"])
        for state, snap in _both(tour, stop)
        for c in _chrome(snap)
        if c["round"]
        and not c["disc"]
        and not (
            snap["pill"] and c["id"] in IN_CAPSULE
        )  # (inside the open capsule they share its glass)
    ]
    assert not bare, bare


# Stops where the info corner says where you are (bottom left); elsewhere it says nothing or the mode's own caption does.
INFO = ("orbit", "ufo", "stand", "drive", "site", "mission", "pad")
INFO_LINES = 3


@pytest.mark.parametrize("stop", _cases("lines"))
def test_the_info_corner_says_where_once_in_whole_lines_bottom_left(tour, stop):
    view = LANDSCAPE if stop.startswith("wide-") else PORTRAIT
    words = [c for c in tour[stop]["shut"]["controls"] if c["kind"] == "words"]
    info = [c for c in words if c["id"].startswith("ah-info-")]
    one = tuple(i["id"] for i in info) + (("ae-hint",) if stop.replace("wide-", "") in ("orbit", "planets") else ())  # (the caption too, where it stands over the picture)
    long = [(c["id"], c["lines"]) for c in words if c["id"] in one and c["lines"] > 1]
    assert not long, long
    assert len(info) <= INFO_LINES, info
    if stop.replace("wide-", "") not in INFO:
        return
    assert info and info[0]["id"] == "ah-info-0", "the info corner says nothing here"
    name = info[0]["text"]
    for c in info:
        box = c["box"]
        assert box[0] < view["width"] / 2 and box[1] > view["height"] / 2, (c["id"], "not bottom left", box)
        assert box[0] + box[2] <= view["width"] - INSET_PX, (c["id"], "runs off the edge", box)
    again = [c["id"] for c in words if c not in info and c["text"] == name]
    assert not again, ("the name is said twice", name, again)
    assert not tour[stop]["shut"].get("named"), "a name still stands under the time chip"


@pytest.mark.local_gate   # sizes a button that is still scaling in when a software-GL frame stalls
@pytest.mark.parametrize("stop", _cases("hit"))
def test_every_control_is_a_fingers_width(tour, stop):
    small = [
        (state, c["id"], c["box"])
        for state, snap in _both(tour, stop)
        for c in _chrome(snap)
        if c["kind"] == "tap" and not c["hit"] and not c["top"] and not c["inRow"]
    ]
    assert not small, small


@pytest.mark.parametrize("stop", _cases("ufo"))
def test_the_ufo_button_is_there_where_it_is_promised(tour, stop):
    want = UFO[stop.replace("wide-", "")]
    for state, snap in _both(tour, stop):
        got = [c for c in snap["controls"] if c["id"] == "ae-fly-btn"]
        if want is None:
            assert not got, (state, "the UFO button shows")
        else:
            assert len(got) == 1, (state, "no UFO button")
            assert got[0]["pressed"] == (want == "on"), (state, got[0])
            assert (
                got[0]["box"][1] < EDGE_PX
                and got[0]["box"][0] > snap_width(tour, stop) - EDGE_PX
            ), (state, got[0]["box"])


def snap_width(tour, stop):
    return (LANDSCAPE if stop.startswith("wide-") else PORTRAIT)["width"]


def _slot(key, view):
    side, edge = CORNERS[key]
    return [
        INSET_PX if side == "left" else view["width"] - INSET_PX - HERO_PX,
        TOP_PX if edge == "top" else view["height"] - INSET_PX - HERO_PX,
        HERO_PX,
        HERO_PX,
    ]


@pytest.mark.local_gate
@pytest.mark.parametrize("stop", _cases("corners"))
def test_each_corner_control_stands_in_its_one_place_at_its_one_size(tour, stop):
    view = LANDSCAPE if stop.startswith("wide-") else PORTRAIT
    for state, snap in _both(tour, stop):
        heroes = [c for c in snap["controls"] if c["rank"] == "hero"]
        assert "ae-back" in [c["id"] for c in heroes], (state, "no way out")
        for c in heroes:
            assert c["id"] in CORNERS, (state, c["id"], "is drawn as a corner")
            assert c["box"] == _slot(c["id"], view), (state, c["id"], c["box"])
        foot = _slot("ae-rim", view)
        lines = set()  # every small disc (the layer's glyphs, a mode's own tools) stands on one line: just above the corners' row,
        for c in snap["controls"]:  # or on a phone on its side on that row beside the foot (a dock's own transport is the dock's)
            if c["rank"] != "minor" or c["inDock"]:
                continue
            box = c["box"]
            assert box[2:] == [MINOR_PX, MINOR_PX], (state, c["id"], box)
            if c["id"] in EDGE_LAYERS:  # Landmarks and Orbits stand in a column right over the locate button, off the line
                you = [y["box"] for y in snap["controls"] if y["id"] == "ae-locate"]
                assert you and box[0] == you[0][0] and box[1] + box[3] <= you[0][1], (state, c["id"], "stands over the locate button", box, you)
                continue
            lines.add(box[1] + box[3] / 2)
        assert len(lines) < 2, (state, "small discs off their one line", sorted(lines))
        if stop.startswith("wide-"):
            assert all(y <= foot[1] + foot[3] / 2 for y in lines), (state, "the small discs stand on the foot's line or above it", sorted(lines), foot)
        else:
            assert all(y + MINOR_PX / 2 <= foot[1] for y in lines), (state, "the small discs stand above the corners' row", sorted(lines), foot)


@pytest.mark.parametrize("stop", _cases("taps"))
def test_each_corner_control_takes_a_real_tap(tour, stop):
    taps = tour[stop]["taps"]
    assert taps, "no corner control at this stop"
    missed = {k: v for k, v in taps.items() if v != k}
    assert not missed, missed


@pytest.mark.parametrize("stop", _cases("search"))
def test_search_stands_in_its_corner_where_there_is_somewhere_to_go(tour, stop):
    view = LANDSCAPE if stop.startswith("wide-") else PORTRAIT
    for state, snap in _both(tour, stop):
        got = [c for c in snap["controls"] if c["id"] == "ae-find"]
        if stop.replace("wide-", "") not in FIND:
            assert not got, (state, "search shows", got)
            continue
        assert len(got) == 1, (state, "no search")
        assert got[0]["box"] == [
            INSET_PX,
            view["height"] - INSET_PX - FIND_PX,
            FIND_PX,
            FIND_PX,
        ], (state, got[0]["box"])
        assert not got[0]["inRow"], "search stands in the worlds' track"


@pytest.mark.parametrize(
    "stop", _cases("track", [s for s in ALL if s.replace("wide-", "") in TRACK_STOPS])
)
def test_no_world_shows_beside_or_behind_search_wherever_the_track_is(tour, stop):
    track = tour[stop]["track"]
    assert track and track["seen"], "no track at this stop"
    assert not track["hits"], track["hits"]


@pytest.mark.local_gate
@pytest.mark.parametrize("stop", _cases("return", list(RETURNS)))
def test_leaving_a_mode_gives_the_orbit_view_back_as_it_was(tour, stop):
    home, after = tour["home"], tour[stop]["after"]
    assert after["snap"]["mode"] == "orbit", after["snap"]["mode"]

    def places(
        snap,
    ):  # every control and where it stands (the chip is as wide as the time it says: its place, not its width)
        return sorted(
            (c["id"], c["box"][:2] if c["id"] == "ae-clock" else c["box"])
            for c in _chrome(snap)
            if c["kind"] == "tap" and not c["inRow"]
        )

    assert [p[0] for p in places(after["snap"])] == [
        p[0] for p in places(home["snap"])
    ], (places(after["snap"]), places(home["snap"]))
    moved = [
        (a, b)
        for a, b in zip(places(after["snap"]), places(home["snap"]))
        if a[0] != "ae-clock" and a != b
    ]
    assert not moved, moved
    assert after["live"] == home["live"], "the clock did not come back as it was"


FIND_XY = "() => { var r = document.getElementById('ae-find').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"
MARS_XY = """() => { var e = document.querySelector("#ae-go [data-ae-go='mars']"); e.scrollIntoView({ block: 'center' });
  var r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return e === t || e.contains(t) ? [r.left + r.width / 2, r.top + r.height / 2] : null; }"""
AT_MARS = "() => _aeMode() === 'orbit' && !_ae.fly && _ae.target === 'mars' && !_ae.stand && !_ae.site && !_ae.mission && document.getElementById('ae-go').hidden"


def test_search_works_from_the_ground_and_a_mission_and_a_choice_leaves_them(library):  # noqa: F811
    """A finger on search opens the sheet in each of these modes, and a world chosen there leaves the mode for that world."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT, "dark")
            # (A frame on software GL takes longer than the stall guard allows, so a timed fall never gets anywhere there: the moves
            # are taken as done at once. What is tested is the search in each mode, not the length of the way into it.)
            pg.emulate_media(reduced_motion="reduce")
            for name in GROUND:
                pg.evaluate("() => { _aePreset('earth'); }")
                pg.wait_for_function(HOME, timeout=240_000, polling=250)
                go, there = ENTER[name]
                pg.evaluate(go)
                pg.wait_for_function(there, timeout=240_000, polling=250)
                pg.wait_for_function(SHOWN, timeout=20_000, polling=100)
                pg.wait_for_timeout(600)
                pg.touchscreen.tap(*pg.evaluate(FIND_XY))
                pg.wait_for_function("() => !document.getElementById('ae-go').hidden && document.getElementById('ae-go').getBoundingClientRect().height > 200", timeout=10_000)
                assert pg.evaluate("() => _aeMode()") == name, "opening search left the mode"
                xy = pg.evaluate(MARS_XY)
                assert xy, (name, "the sheet's Mars is under something")
                pg.touchscreen.tap(*xy)
                pg.wait_for_function(AT_MARS, timeout=120_000, polling=250)
                assert not errors, (name, errors)
            ctx.close()
        finally:
            br.close()


# The pointers to worlds out of the picture (the scene's own tags) against everything of the layer's they may not cover.
POINTERS = """() => { var view = _ae.el, hits = [], shown = 0;
  var keep = Array.prototype.map.call(view.querySelectorAll('.af-lever,.ah-hero,.ah-minor,#ah-info,#ae-views'), function (e) { return [e.id || e.className, _ahSeenBox(e, view)]; }).filter(function (k) { return k[1]; });
  Array.prototype.forEach.call(view.querySelectorAll('#af-refs .af-ref'), function (t) {
    var b = _ahSeenBox(t, view);
    if (!b) return;
    shown++;
    keep.forEach(function (k) { if (b.l < k[1].r && b.r > k[1].l && b.t < k[1].b && b.b > k[1].t) hits.push([t.textContent, k[0], Math.round(b.l), Math.round(b.t)]); });
  });
  return { hits: hits, shown: shown, kept: keep.length }; }"""
LOOK_STEPS = 36  # a look right round, a tenth of a turn or so at a time, nodding as it goes
LOOK = "(i) => { var sh = _ae.ship; sh.look.x += 70; sh.look.y += [60, -60, -60, 60][i % 4]; _aeKick(); }"


# Where the worlds stand against the ship (so which pointers are in the picture, and where) follows the date: eight instants spread
# over a month (87 hours apart), never the wall clock the suite happens to run at.
SWEEP_FROM_MS, SWEEP_STEP_MS = 1_795_219_200_000, 87 * 3_600_000   # 2026-11-21 00:00 UTC


@pytest.mark.parametrize("view", [PORTRAIT, {"width": 360, "height": 740}, LANDSCAPE], ids=["390", "360", "wide"])
@pytest.mark.parametrize("step", range(8))
def test_no_pointer_to_a_world_covers_a_lever_a_corner_the_info_corner_or_the_row(library, view, step):  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, view, "dark")
            at = SWEEP_FROM_MS + step * SWEEP_STEP_MS
            pg.evaluate("(ms) => _aeGoTo(ms)", at)
            pg.wait_for_function("(ms) => Math.abs(_aeDisplayMs() - ms) < 1000", arg=at, timeout=STEP_MS, polling=100)
            go, there = ENTER["ufo"]
            pg.evaluate(go)
            pg.wait_for_function(there, timeout=STEP_MS, polling=250)
            pg.wait_for_function(SHOWN, timeout=FADE_MS, polling=100)
            hits, shown = [], 0
            for i in range(LOOK_STEPS):
                pg.evaluate(LOOK, i)
                pg.wait_for_timeout(500)  # past the layer's own reading of where its controls stand
                got = pg.evaluate(POINTERS)
                assert got["kept"] >= 5, got  # two levers, corners and the info corner were there to be covered
                shown += got["shown"]
                hits += [[i] + h for h in got["hits"]]
            assert shown > LOOK_STEPS / 2, ("the pointers were hardly ever up", shown)
            assert not hits, hits
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


def test_the_first_flights_words_go_by_themselves_and_stay_away(library):  # noqa: F811
    """A trip the autopilot flies touches no lever: the hint has its few seconds and is not back on the next flight."""
    from playwright.sync_api import sync_playwright

    hint = "() => { var h = document.getElementById('af-hint'); return !!h && !h.hidden && h.getBoundingClientRect().height > 0; }"
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT, "dark")
            go, there = ENTER["ufo"]
            pg.evaluate(go)
            pg.wait_for_function(there, timeout=STEP_MS, polling=250)
            assert pg.evaluate(hint), "the first flight says how it is flown"
            stay = pg.evaluate("() => AE_HINT_MS")
            pg.wait_for_timeout(stay + 500)
            assert not pg.evaluate(hint), "untouched, the hint was still up after %d ms" % stay
            pg.evaluate(LEAVE["ufo"])
            pg.wait_for_function(HOME, timeout=STEP_MS, polling=250)
            pg.evaluate(go)
            pg.wait_for_function(there, timeout=STEP_MS, polling=250)
            pg.wait_for_timeout(SETTLE_MS)
            assert not pg.evaluate(hint), "the hint came back on the second flight"
            assert not errors, errors
            ctx.close()
        finally:
            br.close()


# In flight: is a card up, are the info corner's words and both levers the top thing where they stand?
FLIGHT_FOOT = """() => { var view = _ae.el, card = document.getElementById('ae-card'), out = { mode: _aeMode(), card: !!_ahSeenBox(card, view), covered: [] };
  var info = document.getElementById('ah-info'), line = info && info.firstElementChild;
  out.says = line ? line.textContent : '';
  [line].concat(Array.prototype.slice.call(view.querySelectorAll('.af-lever'))).forEach(function (el) {
    var b = el && _ahSeenBox(el, view);
    if (!b) { out.covered.push((el && el.id || 'info') + ' not seen'); return; }
    [[0.5, 0.2], [0.5, 0.5], [0.5, 0.8]].forEach(function (p) {
      var top = document.elementFromPoint(b.l + p[0] * (b.r - b.l), b.t + p[1] * (b.b - b.t));
      if (top && top.closest('#ae-card,.as-sheet,#ae-go,#ae-info')) out.covered.push((el.id || 'info') + ' under ' + (top.id || top.className));
    });
  });
  return out; }"""
SAT_CARD = "() => { var c = document.getElementById('ae-card'); return !!c && !c.hidden && typeof _as !== 'undefined' && _as.sel >= 0; }"


def test_a_card_never_rides_into_a_flight_nor_comes_up_in_one(library):  # noqa: F811
    """A satellite's card is up; the UFO button is tapped. The card goes, and no tap in the flight's picture brings one
    back: the info corner says where and the levers stand clear, from the first frame to a trip under way."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch(args=GL_ARGS)
        try:
            ctx, pg, errors = _open(br, library, PORTRAIT, "dark")
            pg.evaluate("() => _aeSatsAllSet(true)")
            pg.wait_for_function("() => typeof _as !== 'undefined' && _as.on && !!_as.data", timeout=60_000, polling=200)
            pg.evaluate("() => _asSelect(5)")
            pg.wait_for_function(SAT_CARD, timeout=10_000)
            box = pg.locator("#ae-fly-btn").bounding_box()
            pg.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            pg.wait_for_function(ENTER["ufo"][1], timeout=STEP_MS, polling=250)
            pg.wait_for_function(SHOWN, timeout=FADE_MS, polling=100)
            # (the info line fades in by its own ease, counted in frames: sample once it is seen; the contract is what covers it)
            pg.wait_for_function("() => { var l = document.getElementById('ah-info'); l = l && l.firstElementChild; return !!l && !!_ahSeenBox(l, _ae.el); }", timeout=FADE_MS, polling=100)
            seen = [pg.evaluate(FLIGHT_FOOT)]
            for x, y in ((195, 420), (195, 200), (120, 330)):  # taps in the picture, where satellites and places are
                pg.touchscreen.tap(x, y)
                pg.wait_for_timeout(SETTLE_MS)
                seen.append(pg.evaluate(FLIGHT_FOOT))
            pg.evaluate("() => _asSelect(7)")  # and a satellite chosen by any other way
            pg.wait_for_timeout(SETTLE_MS)
            seen.append(pg.evaluate(FLIGHT_FOOT))
            for got in seen:
                assert got["mode"] == "ufo" and not got["card"] and not got["covered"] and got["says"], seen
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
