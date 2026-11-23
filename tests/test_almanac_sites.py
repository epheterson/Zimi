"""The landing sites of the 3D view (almanac-sites.js): the data holds together.

Every site is a landing the landmarks file already names, at that file's latitude and longitude; every model it stands is a
file that parses (the ZCR2 format of the other craft); every string the code reads is in all ten languages. The browser
test (test_almanac_sites_browser.py) then checks the same on a rendered page.

Run: pytest tests/test_almanac_sites.py -v
"""

import datetime
import json
import math
import os
import re
import struct

import pytest

from scripts.i18n_split import words

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
STATIC = os.path.join(ROOT, "zimi", "static")
MAX_PALETTE = (
    12  # AE_CRAFT_PAL in almanac-earth.js: a model's shader holds this many colours
)


def _utc_ms(*a):
    return int(datetime.datetime(*a, tzinfo=datetime.timezone.utc).timestamp() * 1000)


@pytest.fixture(scope="module")
def sites():
    with open(os.path.join(EARTH, "sites-v1.json"), encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def landmarks():
    with open(os.path.join(EARTH, "landmarks-v1.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _parse(name):
    """A site model (ZCR2, or the older flat-shaded ZCRF) as (palette entries, vertex count, indices, box)."""
    with open(os.path.join(EARTH, "craft-site-%s-v1.bin" % name), "rb") as fh:
        b = fh.read()
    magic = b[:4]
    assert magic in (b"ZCR2", b"ZCRF")
    version, metres = struct.unpack_from("<If", b, 4)
    assert version == (2 if magic == b"ZCR2" else 1) and metres > 0
    box = struct.unpack_from("<6f", b, 12)
    if magic == b"ZCR2":
        palette_n, nv, nt, flags = struct.unpack_from("<4I", b, 60)
        assert flags == 0, "a site's model has no UVs or textures"
        o = 88 + 24 * palette_n + nv * 9
    else:
        palette_n = struct.unpack_from("<I", b, 60)[0]
        o = 64 + 20 * palette_n
        nv, nt = struct.unpack_from("<II", b, o)
        o += 8 + nv * 8
    width = 4 if nv > 65535 else 2
    assert (
        len(b) == o + nt * 3 * width
    ), "the file is exactly its header, vertices and indices"
    idx = struct.unpack_from("<%d%s" % (nt * 3, "I" if width == 4 else "H"), b, o)
    return palette_n, nv, idx, box


def test_every_site_is_a_landing_in_the_landmarks_at_its_coordinates(sites, landmarks):
    assert len(sites["sites"]) >= 30
    for s in sites["sites"]:
        rows = [r for r in landmarks[s["body"]] if r[0] == s["name"]]
        assert len(rows) == 1, "%s is one landing of %s" % (s["name"], s["body"])
        assert rows[0][3] in ("landing", "launch")
        pad = s.get("pad")
        if (
            pad
        ):  # a launch pad is within a few kilometres of the place the landmarks name
            assert (
                abs(pad["lat"] - rows[0][1]) < 0.3
                and abs(pad["lon"] - rows[0][2]) < 0.3
            )


def test_the_sites_the_brief_names_are_all_there(sites):
    have = {(s["body"], s["name"]) for s in sites["sites"]}
    wanted = [("moon", "Apollo %d" % n) for n in (11, 12, 14, 15, 16, 17)] + [
        ("moon", "Luna 17"),
        ("moon", "Luna 21"),
    ]
    wanted += [("moon", "Chang'e %d" % n) for n in (3, 4, 5)]
    wanted += [
        ("mars", n)
        for n in (
            "Viking 1",
            "Viking 2",
            "Mars Pathfinder",
            "Spirit",
            "Opportunity",
            "Curiosity",
            "Perseverance",
            "Zhurong",
            "InSight",
            "Phoenix",
        )
    ]
    wanted += [("titan", "Huygens"), ("venus", "Venera 13"), ("venus", "Venera 14")]
    for w in wanted:
        assert w in have, "%s %s has a site" % w


def test_the_landing_dates_are_in_order_for_the_missions_that_have_them(sites):
    when = {s["name"]: s["ms"] for s in sites["sites"]}
    order = [
        "Apollo 11",
        "Apollo 12",
        "Apollo 14",
        "Apollo 15",
        "Apollo 16",
        "Apollo 17",
    ]
    assert [when[n] for n in order] == sorted(when[n] for n in order)
    # 20 July 1969, 20:17 UTC
    assert abs(when["Apollo 11"] - _utc_ms(1969, 7, 20, 20, 17)) < 120_000
    assert when["Curiosity"] < when["Perseverance"]


def test_every_part_a_site_names_has_its_name_in_every_language(sites):
    # A Luna 16 visit showed "alm_site_..." under its lander in the strip: every part a site stands is named in each of the
    # ten languages (almanac-sites.js _asPartNameKey), so no strip or info line ever shows a raw key.
    def key(m):
        return "alm_site_p_" + re.sub(
            r"-\d+$", "", re.sub(r"-(body|wheel)$", "", m)
        ).replace("-", "_")

    wanted = {key(p["m"]) for s in sites["sites"] for p in s.get("parts", [])}
    wanted |= {key(m) for r in sites["rovers"].values() for m in r.values()}
    i18n = os.path.join(ROOT, "zimi", "static", "i18n")
    for name in sorted(n for n in os.listdir(i18n) if n.endswith(".json")):
        strings = words(name[: -len(".json")])
        missing = sorted(
            k for k in wanted if not strings.get(k) or strings[k].startswith("alm_")
        )
        assert not missing, (name, missing)


def test_every_model_a_site_stands_is_a_file_that_parses(sites):
    used = set()
    for s in sites["sites"]:
        for p in s["parts"]:
            if p["m"] in sites["rovers"]:
                used.add(sites["rovers"][p["m"]]["body"])
                used.add(sites["rovers"][p["m"]]["wheel"])
            else:
                used.add(p["m"])
    for name in sorted(used):
        assert name in sites["models"], name
        palette_n, nv, idx, box = _parse(name)
        assert 1 <= palette_n <= MAX_PALETTE, name
        assert max(idx) < nv, "%s: an index past its vertices" % name
        assert len(idx) % 3 == 0 and nv < 20000, name


def test_a_models_size_in_the_table_is_its_boxs(sites):
    for name, meta in sites["models"].items():
        _pal, _nv, _idx, box = _parse(name)
        ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]]
        assert all(abs(a - b) < 0.01 for a, b in zip(ext, meta["size"])), name


def test_the_models_are_the_size_of_the_real_thing(sites):
    size = lambda n: sites["models"][n]["size"]
    assert 9.0 < max(size("lm")[:2]) < 9.6, "the Lunar Module's legs span 9.4 m"
    assert 2.9 < size("lrv-body")[1] < 3.4, "the Roving Vehicle is 3.1 m long"
    assert 108 < size("saturn5")[2] < 113, "the Saturn V is 110.6 m"
    assert 5.5 < size("insight")[0] < 6.5, "InSight's panels span 6 m"
    assert 0.8 < size("ingenuity")[0] < 1.3 and size("ingenuity")[2] < 0.7


def test_a_rovers_wheels_stand_on_the_ground(sites):
    for key, asm in sites["rovers"].items():
        body, wheel = sites["models"][asm["body"]], sites["models"][asm["wheel"]]
        meta = wheel if "at" in wheel else body["wheels"]
        radius = wheel.get("radius") or body["wheels"]["radius"]
        assert len(meta["at"]) in (4, 6, 8), key
        for x, y, z in meta["at"]:
            assert abs(z - radius) < 0.02, (
                "%s: a hub is its radius over the ground" % key
            )


def test_the_stage_carries_the_files_and_the_server_versions_them():
    with open(os.path.join(ROOT, "zimi", "almanacstage.py"), encoding="utf-8") as fh:
        stage = fh.read()
    with open(os.path.join(ROOT, "zimi", "http.py"), encoding="utf-8") as fh:
        http = fh.read()
    for f in (
        "almanac-sites.js",
        "almanac-sites-ground.js",
        "almanac-sites-drive.js",
        "almanac-sites-launch.js",
        "almanac-sites-trail.js",
    ):
        assert '"%s"' % f in stage, f
        assert '_static_hash("%s")' % f in http, f


def test_the_strings_the_code_reads_are_in_every_language():
    src = ""
    for f in (
        "almanac-sites.js",
        "almanac-sites-ground.js",
        "almanac-sites-drive.js",
        "almanac-sites-launch.js",
        "almanac-sites-trail.js",
    ):
        with open(os.path.join(STATIC, f), encoding="utf-8") as fh:
            src += fh.read()
    keys = {
        k for k in re.findall(r"'(alm_site_[a-z_]+)'", src) if not k.endswith("_")
    }  # a prefix (the part names) is not a key
    assert {
        "alm_site_visit",
        "alm_site_drive",
        "alm_site_landed",
    } <= keys
    for lang in ("en", "de", "es", "fr", "pt", "ru", "zh", "ar", "he", "hi"):
        d = words(lang)
        for k in keys:
            assert d.get(k), "%s has %s" % (lang, k)


def test_every_body_a_site_is_on_has_ground_in_the_code(sites):
    with open(os.path.join(STATIC, "almanac-sites.js"), encoding="utf-8") as fh:
        src = fh.read()
    for body in {s["body"] for s in sites["sites"]}:
        assert re.search(r"^\s+%s: \{ albedo" % body, src, re.M), body


def _jd(y, m, d):
    return (datetime.date(y, m, d) - datetime.date(1858, 11, 17)).days + 2400000.5


def test_the_voyagers_real_paths_start_at_their_launches_and_run_to_today():
    """The replay from launch (almanac-earth.js _aeReplayFrom) plays JPL Horizons tables that begin on the launch day."""
    with open(os.path.join(EARTH, "space-tracks-v1.json"), encoding="utf-8") as fh:
        tracks = json.load(fh)["tracks"]
    for key, launch in (("voyager1", (1977, 9, 5)), ("voyager2", (1977, 8, 20))):
        t = tracks[key]
        ev = [e for e in t["events"] if e[1] == "launch"][0]
        assert abs(ev[0] - _jd(*launch)) <= 1, key
        assert abs(t["jd0"] - ev[0]) <= 16, "%s: the table begins at the launch" % key
        assert t["jd1"] > _jd(2026, 11, 1), "%s: and runs past today" % key
        assert any(e[1] == "flyby" and e[2] == "Jupiter" for e in t["events"]), key


def test_a_rovers_route_begins_at_its_landing_and_reaches_where_it_is_now(sites):
    """The route replay (almanac-sites-trail.js): Curiosity's and Perseverance's drives from NASA's waypoints."""
    with open(os.path.join(EARTH, "traverses-v1.json"), encoding="utf-8") as fh:
        routes = json.load(fh)
    by_name = {s["name"]: s for s in sites["sites"]}
    with open(os.path.join(EARTH, "landmarks-v1.json"), encoding="utf-8") as fh:
        mars = {r[0]: r for r in json.load(fh)["mars"]}
    for key, name, last_sol in (
        ("msl", "Curiosity", 5000),
        ("m20", "Perseverance", 2000),
    ):
        r = routes[key]
        assert by_name[name]["trail"] == key
        pts = r["points"]
        assert pts == sorted(pts, key=lambda p: p[0]), "in order of sol"
        assert (
            abs(pts[0][1] - mars[name][1]) < 0.01
            and abs(pts[0][2] - mars[name][2]) < 0.01
        ), "it begins at the landing"
        assert pts[-1][0] > last_sol, "and runs to the present"
        assert len(pts) > 300
        assert (
            abs(r["landingMs"] - by_name[name]["ms"]) < 120_000
        ), "the same landing instant as the site's"
        far = max(abs(p[1] - pts[0][1]) + abs(p[2] - pts[0][2]) for p in pts)
        assert (
            0.1 < far < 3
        ), "a route of tens of kilometres, not a point and not a planet"


def test_the_almanac_pack_keeps_every_file_a_site_needs_for_the_offline_worker(sites):
    """sw.js keeps http._almanac_pack_urls() when the Almanac is opened: the sites' code, table, routes and models."""
    from zimi import http as zhttp

    urls = {u.split("?")[0] for u in zhttp._almanac_pack_urls()}
    for f in (
        "almanac-sites.js",
        "almanac-sites-ground.js",
        "almanac-sites-drive.js",
        "almanac-sites-launch.js",
        "almanac-sites-trail.js",
    ):
        assert "/static/" + f in urls, f
    for f in (
        "sites-v1.json",
        "site-thumbs-v1.webp",
        "traverses-v1.json",
        "landmarks-v1.json",
    ):
        assert "/static/earth/" + f in urls, f
    for name in sites["models"]:
        assert "/static/earth/craft-site-%s-v1.bin" % name in urls, name


def test_the_almanac_zim_carries_the_sites(tmp_path):
    """The stage copies the files the sites ask for by relative address (almanacstage SCRIPTS, LAZY and the earth folder)."""
    from zimi import almanacstage as stage

    names = set(stage.SCRIPTS) | set(stage.LAZY)
    for f in (
        "almanac-sites.js",
        "almanac-sites-ground.js",
        "almanac-sites-drive.js",
        "almanac-sites-launch.js",
        "almanac-sites-trail.js",
    ):
        assert f in names, f
    assert (
        "earth" in stage.DATA
    ), "the whole earth folder: the table, the routes and every model"


def test_every_landing_the_landmarks_name_has_a_model_to_stand_at(sites, landmarks):
    """every corner complete. A landing in landmarks-v1.json that is not a site is a hole."""
    have = {(s["body"], s["name"]) for s in sites["sites"]}
    for body, rows in landmarks.items():
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], list):
            continue
        for r in rows:
            if r[3] == "landing":
                assert (body, r[0]) in have, "%s %s has no site" % (body, r[0])


# ── The Apollo sites: what stands where (scripts/build_apollo_sites.py) ──
MOON_M_PER_DEG = 1737400.0 * math.pi / 180
APOLLO = {
    "Apollo 11": {"lm", "lm-ascent", "flag", "flag-down", "lrrr-11", "psep", "tv"},
    "Apollo 12": {
        "lm",
        "lm-ascent",
        "flag",
        "tv",
        "sband",
        "sband-down",
        "alsep",
        "pse",
        "surveyor",
    },
    "Apollo 14": {
        "lm",
        "lm-ascent",
        "flag",
        "sband",
        "sband-down",
        "tv",
        "met",
        "alsep",
        "pse",
        "lrrr-14",
    },
    "Apollo 15": {"lm", "lm-ascent", "flag", "alsep", "pse", "lrrr-15", "lrv"},
    "Apollo 16": {"lm", "lm-ascent", "flag", "alsep", "pse", "lrv"},
    "Apollo 17": {"lm", "lm-ascent", "flag", "alsep", "lrv"},
}


def _apollo(sites, name):
    return [s for s in sites["sites"] if s["name"] == name][0]


def _part(site, model, nth=0):
    return [p for p in site["parts"] if p["m"] == model][nth]


def _dist(a, b):
    return math.hypot(a["x"] - b[0], a["y"] - b[1])


@pytest.mark.parametrize("name", sorted(APOLLO))
def test_an_apollo_site_has_every_part_it_lists_each_with_its_source(sites, name):
    site = _apollo(sites, name)
    assert {p["m"] for p in site["parts"]} == APOLLO[name]
    for p in site["parts"]:
        assert (
            p["src"] in sites["sources"]
        ), "%s %s: a source the table does not hold" % (name, p["m"])
        assert (
            isinstance(p["err"], (int, float)) and p["err"] > 0
        ), "%s %s: no error" % (name, p["m"])
        assert p["m"] in sites["models"] or p["m"] in sites["rovers"], p["m"]
    for row in site.get("relief", []) + site.get("tracks", []):
        assert row["n"]
    for row in site.get("relief", []):
        assert row["src"] in sites["sources"] and row["r"] > 0 and row["d"] > 0, row[
            "n"
        ]


@pytest.mark.parametrize("name", sorted(APOLLO))
def test_a_part_measured_as_a_latitude_and_longitude_stands_where_that_puts_it(
    sites, name
):
    site = _apollo(sites, name)
    lat0, lon0 = _part(site, "lm")["ll"]
    for p in site["parts"]:
        if "ll" not in p:
            continue
        x = (p["ll"][1] - lon0) * MOON_M_PER_DEG * math.cos(math.radians(lat0))
        y = (p["ll"][0] - lat0) * MOON_M_PER_DEG
        assert abs(p["x"] - x) < 0.15 and abs(p["y"] - y) < 0.15, "%s %s" % (
            name,
            p["m"],
        )


def test_apollo_11s_things_are_where_the_site_photogrammetry_puts_them(sites):
    """Pustynski and Jones (ALSJ): the flag 10.7 m from the LM's centre and 7.8 m from the +Y pad, the retroreflector 18 m and the
    seismometer 24 m from the -Y pad; the LM landed 13.3 degrees counterclockwise from east-west (its front, the +Z pad, to the
    west-southwest)."""
    site = _apollo(sites, "Apollo 11")
    front = math.radians(_part(site, "lm")["h"])
    assert abs(_part(site, "lm")["h"] - (270 - 13.3)) < 0.1
    pad = 4.28  # a footpad's middle, from the centre (9.5 m across the outer edges, less a pad's width)
    plus_y = (pad * math.sin(front + math.pi / 2), pad * math.cos(front + math.pi / 2))
    minus_y = (-plus_y[0], -plus_y[1])
    flag = _part(site, "flag")
    assert abs(math.hypot(flag["x"], flag["y"]) - 10.7) < 0.3
    assert abs(_dist(flag, plus_y) - 7.8) < 0.4
    assert (
        abs(_dist(_part(site, "lrrr-11"), minus_y) - 18) < 2
    ), "the map: 60 feet from the middle of the -Y pad"
    assert abs(_dist(_part(site, "psep"), minus_y) - 24) < 2, "the map: about 80 feet"
    # The flag points 24 degrees south of east; the model's flag extends to its +x, which is `h` degrees clockwise from east.
    assert abs(flag["h"] - 24) < 0.1
    # The ascent engine blew it over: standing until the liftoff, down after.
    assert (
        _part(site, "flag")["until"]
        == site["liftoff"]
        == _part(site, "flag-down")["from"]
    )


def test_the_other_apollo_distances_agree_with_the_journal(sites):
    """The ALSJ's own estimates, within what they say they are good to (the LROC position wins where they differ)."""
    a12, a14, a15 = (_apollo(sites, n) for n in ("Apollo 12", "Apollo 14", "Apollo 15"))
    zero = (0, 0)
    assert (
        abs(_dist(_part(a12, "alsep"), zero) - 126) < 6
    ), "Central Station about 126 m from the LM (LROC map)"
    assert (
        abs(_dist(_part(a12, "surveyor"), zero) - 155) < 10
    ), "Surveyor III about 155 m from Intrepid"
    cs = _part(a14, "alsep")
    assert (
        abs(_dist(_part(a14, "lrrr-14"), (cs["x"], cs["y"])) - 30.5) < 3
    ), "the LR-cubed 100 feet west of the Central Station"
    assert _part(a14, "lrrr-14")["x"] < cs["x"]
    az = (
        math.degrees(math.atan2(_part(a15, "alsep")["x"], _part(a15, "alsep")["y"]))
        % 360
    )
    assert abs(az - 297) < 6, "the Apollo 15 ALSEP lies at azimuth 297"
    assert (
        95 < _dist(_part(a15, "alsep"), zero) < 130
    ), "125 m in the report, 105 m measured by LROC"
    for n, lo, hi in (
        ("Apollo 15", 120, 170),
        ("Apollo 16", 70, 90),
        ("Apollo 17", 125, 160),
    ):
        d = _dist(_part(_apollo(sites, n), "lrv"), zero)
        assert lo < d < hi, "%s: the rover parked %.0f m from the LM" % (n, d)
    a16 = _part(_apollo(sites, "Apollo 16"), "lrv")
    assert (
        70 < math.degrees(math.atan2(a16["x"], a16["y"])) % 360 < 95
    ), "east of the LM, azimuth about 88"


def test_the_apollo_flags_stand_near_their_landers_at_the_bearings_the_reports_give(
    sites,
):
    a15 = _part(_apollo(sites, "Apollo 15"), "flag")
    assert abs(math.hypot(a15["x"], a15["y"]) - 11) < 0.5
    assert abs(math.degrees(math.atan2(a15["x"], a15["y"])) - 30) < 1
    for n in sorted(APOLLO):
        f = _part(_apollo(sites, n), "flag")
        assert 8 < math.hypot(f["x"], f["y"]) < 20, (
            "%s: the flag is 10 to 17 m from the LM" % n
        )


def test_every_apollo_part_has_a_name_in_every_language(sites):
    models = {p["m"] for n in APOLLO for p in _apollo(sites, n)["parts"]}
    keys = {
        "alm_site_p_"
        + re.sub(r"-(body|wheel)$", "", re.sub(r"-\d+$", "", m)).replace("-", "_")
        for m in models
    }
    for lang in ("en", "ar", "de", "es", "fr", "he", "hi", "pt", "ru", "zh"):
        strings = words(lang)
        for k in keys:
            assert strings.get(k), "%s lacks %s" % (lang, k)


def test_the_lunar_modules_ladder_side_is_the_models_plus_y():
    """The headings of the Apollo sites are the bearing of the Lunar Module's front (the +Z pad, its ladder and porch) taken as the
    model's +y. The porch is the platform that stands out past the descent stage at the top of the front leg: in the model it
    is on the +y leg and on no other."""
    np = pytest.importorskip("numpy")
    with open(os.path.join(EARTH, "craft-site-lm-v1.bin"), "rb") as fh:
        b = fh.read()
    lo = np.array(struct.unpack_from("<3f", b, 12))
    hi = np.array(struct.unpack_from("<3f", b, 24))
    npal, nv, _nt, _flags = struct.unpack_from("<4I", b, 60)
    a = np.frombuffer(
        b,
        dtype=np.dtype([("p", "<i2", 3), ("n", "i1", 2), ("c", "u1")]),
        count=nv,
        offset=88 + 24 * npal,
    )
    v = (a["p"].astype(float) + 32767) / 65534 * (hi - lo) + lo
    r = np.hypot(v[:, 0], v[:, 1])
    porch = (r > 3.0) & (v[:, 2] > 2.3) & (v[:, 2] < 3.1)
    bearing = (
        np.degrees(np.arctan2(v[porch, 0], v[porch, 1])) % 360
    )  # from +y, clockwise
    near_plus_y = ((bearing < 25) | (bearing > 335)).sum()
    assert near_plus_y > 0.8 * porch.sum() and near_plus_y > 40


def test_surveyor_3_stands_inside_surveyor_crater_just_below_its_rim(sites):
    """The lander is on the crater's wall (USGS: 200 m across), Intrepid a few tens of metres outside the rim (ALSJ: about 25 feet)."""
    a12 = _apollo(sites, "Apollo 12")
    crater = [r for r in a12["relief"] if r["n"] == "Surveyor Crater"][0]
    s3 = _part(a12, "surveyor")
    inside = math.hypot(s3["x"] - crater["x"], s3["y"] - crater["y"])
    assert (
        0.6 * crater["r"] < inside < 0.97 * crater["r"]
    ), "Surveyor 3 on the wall, %.0f m from the middle of a %.0f m crater" % (
        inside,
        crater["r"],
    )
    lm_to_rim = math.hypot(crater["x"], crater["y"]) - crater["r"]
    assert 5 < lm_to_rim < 45, "Intrepid %.0f m outside the rim" % lm_to_rim


def test_the_big_craters_stand_where_the_reports_put_them(sites):
    """West Crater 550 m from Eagle (east), North Ray about 4.7 km north of Orion, Camelot about 900 m beyond Challenger's west side."""

    def crater(n, name):
        return [r for r in _apollo(sites, n)["relief"] if r["n"] == name][0]

    west = crater("Apollo 11", "West Crater")
    assert (
        abs(math.hypot(west["x"], west["y"]) - 550) < 15
        and west["x"] > 500
        and 175 < 2 * west["r"] < 195
    )
    north = crater("Apollo 16", "North Ray Crater")
    assert (
        4400 < math.hypot(north["x"], north["y"]) < 5000
        and north["y"] > 4000
        and 850 < 2 * north["r"] < 960
    )
    camelot = crater("Apollo 17", "Camelot Crater")
    rim_east = -camelot["x"] - camelot["r"]
    assert 500 < rim_east < 1000, (
        "Camelot's eastern rim is %.0f m west of the lander (ALSJ: the planned point was 600 m from it)"
        % rim_east
    )
    for n in ("Apollo 11", "Apollo 16", "Apollo 17"):
        for r in _apollo(sites, n)["relief"]:
            far = math.hypot(r["x"], r["y"])
            assert far < 60 or 2 * r["r"] > 0.15 * far, (
                "%s is wide enough for the ground's rings to hold it" % r["n"]
            )


def test_every_site_part_has_a_picture_in_the_sites_thumbnail_sheet(sites):
    """The strip of what is here draws each thing from site-thumbs-v1.webp: the sheet's table names every model any site stands."""
    th = sites["thumbs"]
    models = set()
    for site in sites["sites"]:
        for p in site["parts"]:
            models.add(
                sites["rovers"][p["m"]]["body"] if p["m"] in sites["rovers"] else p["m"]
            )
    assert models <= set(th["models"]), models - set(th["models"])
    path = os.path.join(EARTH, "site-thumbs-v1.webp")
    assert os.path.getsize(path) < 160_000
    with open(path, "rb") as fh:
        head = fh.read(30)
    assert head[:4] == b"RIFF" and head[8:12] == b"WEBP"
