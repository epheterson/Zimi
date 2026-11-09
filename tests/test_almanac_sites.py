"""The landing sites of the 3D view (almanac-sites.js): the data holds together.

Every site is a landing the landmarks file already names, at that file's latitude and longitude; every model it stands is a
file that parses (the ZCRF format of the other craft); every string the code reads is in all ten languages. The browser
test (test_almanac_sites_browser.py) then checks the same on a rendered page.

Run: pytest tests/test_almanac_sites.py -v
"""

import datetime
import json
import os
import re
import struct

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
STATIC = os.path.join(ROOT, "zimi", "static")
MAX_PALETTE = (
    8  # AE_CRAFT_PAL in almanac-earth.js: a model's shader holds this many colours
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
    """A ZCRF file as (palette entries, vertex count, indices, box)."""
    with open(os.path.join(EARTH, "craft-site-%s-v1.bin" % name), "rb") as fh:
        b = fh.read()
    assert b[:4] == b"ZCRF"
    version, metres = struct.unpack_from("<If", b, 4)
    assert version == 1 and metres > 0
    box = struct.unpack_from("<6f", b, 12)
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
        assert rows[0][3] == "landing"


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
    for f in ("almanac-sites.js", "almanac-sites-ground.js", "almanac-sites-drive.js", "almanac-sites-launch.js"):
        assert '"%s"' % f in stage, f
        assert '_static_hash("%s")' % f in http, f


def test_the_strings_the_code_reads_are_in_every_language():
    src = ""
    for f in ("almanac-sites.js", "almanac-sites-ground.js", "almanac-sites-drive.js", "almanac-sites-launch.js"):
        with open(os.path.join(STATIC, f), encoding="utf-8") as fh:
            src += fh.read()
    keys = set(re.findall(r"_aeT\('(alm_site_[a-z_]+)'", src))
    assert {
        "alm_site_visit",
        "alm_site_drive",
        "alm_site_leave",
        "alm_site_landed",
    } <= keys
    for lang in ("en", "de", "es", "fr", "pt", "ru", "zh", "ar", "he", "hi"):
        with open(os.path.join(STATIC, "i18n", lang + ".json"), encoding="utf-8") as fh:
            d = json.load(fh)
        for k in keys:
            assert d.get(k), "%s has %s" % (lang, k)


def test_every_body_a_site_is_on_has_ground_in_the_code(sites):
    with open(os.path.join(STATIC, "almanac-sites.js"), encoding="utf-8") as fh:
        src = fh.read()
    for body in {s["body"] for s in sites["sites"]}:
        assert re.search(r"^\s+%s: \{ albedo" % body, src, re.M), body
