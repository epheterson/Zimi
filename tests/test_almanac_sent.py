"""The Sent collection's index (zimi/static/earth/sent-v1.json): everything people have sent away from Earth.

Each object has a known state, a `where` that is valid for that state, a source and a class (or model) that exists; a site is
named as sites-v1.json has it; a tracked object is one space-tracks-v1.json carries. Nothing is stored that the clock can work out.

Run: pytest tests/test_almanac_sent.py -v
"""

import json
import os
import re

from scripts.i18n_split import words

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
STATIC = os.path.join(ROOT, "zimi", "static")

STATES = {"standing", "orbiting", "tracked", "leaving", "retired", "ended", "lost"}
ENDINGS = {"burned", "crashed", "failed"}
ENDED_BODIES = {"earth", "moon", "mercury", "venus", "mars", "jupiter", "saturn"}
ORBIT_BODIES = {"earth", "moon", "mars"}
SITE_BODIES = {"moon", "mars", "venus", "titan"}
NOT_A_SENT_SITE = {"Cape Canaveral"}  # a launch pad: where things were sent from
DATE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")


def _load(name):
    with open(os.path.join(EARTH, name), encoding="utf-8") as f:
        return json.load(f)


def _index():
    return _load("sent-v1.json")


def _craft_models():
    """The models a row may name: the app's own craft files, and the ones the Almanac HD pack carries (the builders' keys): the
    standard Almanac shows those as their picture in sent-thumbs-v1.webp."""
    import pytest

    pytest.importorskip("numpy")
    import sys

    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import build_craft_models as bcm
    import build_sent_models as bsm

    return (
        {"iss"}
        | set(bcm.CRAFT)
        | {k.replace("_", "-") for k in bsm.PROCEDURAL}
        | {
            re.match(r"craft-(.+)-v1\.bin", f).group(1)
            for f in os.listdir(EARTH)
            if re.match(r"craft-(?!site-|ms-).+-v1\.bin", f)
        }
    )


def test_index_shape_and_budget():
    d = _index()
    assert d["version"] == 1
    assert d["classes"] and d["objects"]
    ids = [o["id"] for o in d["objects"]]
    assert len(ids) == len(set(ids)), "an id is used twice"
    assert 60 <= len(ids) <= 400
    assert os.path.getsize(os.path.join(EARTH, "sent-v1.json")) < 40_000


def test_every_object_has_a_state_a_source_a_class_and_a_model_that_exists():
    d = _index()
    sites_models = set(_load("sites-v1.json")["models"])
    models = sites_models | _craft_models()
    for o in d["objects"]:
        who = o["id"]
        assert o["state"] in STATES, who
        assert o["cls"] in d["classes"], who
        assert o["src"].startswith("https://"), who
        assert re.match(r"^Q\d+$", o["qid"]), who
        assert o["name"] and o["agency"], who
        assert DATE.match(o["launch"]) and int(o["launch"][:4]) == o["year"], who
        if "model" in o:
            assert o["model"] in models, (who, o["model"])


def test_where_is_valid_for_the_state():
    d = _index()
    sites = {s["name"]: s for s in _load("sites-v1.json")["sites"]}
    tracks = set(_load("space-tracks-v1.json")["tracks"])
    for o in d["objects"]:
        w, st, who = o["where"], o["state"], o["id"]
        if st == "standing":
            assert w["site"] in sites, (who, w["site"])  # named as sites-v1.json has it
            assert (
                sites[w["site"]]["body"] == w["body"] and w["body"] in SITE_BODIES
            ), who
            assert DATE.match(w["at"]) and w["at"] >= o["launch"][:7], who
        elif st == "orbiting":
            if w.get("iss"):
                assert w == {"body": "earth", "iss": True}, who
            else:  # still working at the date its status was read; the place in its orbit is not known here
                assert (
                    w["body"] in ORBIT_BODIES
                    and DATE.match(w["at"])
                    and DATE.match(w["checked"])
                ), who
                assert w["at"] >= o["launch"][:7], who
        elif st in ("tracked", "leaving"):
            assert w["track"] in tracks, (who, w["track"])
        elif (
            st == "retired"
        ):  # switched off in a Sun orbit: its table (held at its end) is the last known place
            assert (
                w["track"] in tracks
                and DATE.match(w["last"])
                and w["last"] >= o["launch"][:7]
            ), who
            tr = _load("space-tracks-v1.json")["tracks"][w["track"]]
            assert tr.get("hold") is True, (who, "its table must hold its last place")
        elif st == "ended":
            assert w["body"] in ENDED_BODIES and w["how"] in ENDINGS, who
            assert DATE.match(w["at"]) and w["at"] >= o["launch"][:7], who
            assert ("lat" in w) == ("lon" in w), who
            if "lat" in w:
                assert -90 <= w["lat"] <= 90 and -180 <= w["lon"] <= 180, who
        elif st == "lost":
            assert DATE.match(w["last"]) and w["last"] >= o["launch"][:7], who
            assert w.get("body", "mars") in ENDED_BODIES, who
            assert "lat" not in w, (who, "a lost thing has no place")


def test_every_landing_site_is_a_row_and_none_is_invented():
    d = _index()
    named = {o["where"]["site"] for o in d["objects"] if o["state"] == "standing"}
    sites = {s["name"] for s in _load("sites-v1.json")["sites"]}
    assert named == sites - NOT_A_SENT_SITE, (
        sorted(sites - named),
        sorted(named - sites),
    )


def test_tracked_rows_are_the_probes_the_tracks_file_carries():
    d = _index()
    rows = {
        o["where"]["track"]
        for o in d["objects"]
        if o["state"] in ("tracked", "leaving", "retired")
    }
    rows |= {
        o["id"]
        for o in d["objects"]
        if o["state"] == "ended" and o["id"] in _load("space-tracks-v1.json")["tracks"]
    }
    probes = {
        k
        for k in _load("space-tracks-v1.json")["tracks"]
        if k not in ("ceres", "vesta")
    }
    assert rows == probes, (sorted(probes - rows), sorted(rows - probes))


def test_the_states_have_a_fixed_small_set_of_words():
    """The words a row can wear are keys in all ten languages; object names are never translated."""
    d = _index()
    assert {o["state"] for o in d["objects"]} == STATES


def test_the_thumbnail_sheet_has_a_cell_for_every_named_model():
    """scripts/build_sent_thumbs.py draws one cell per model the index names, sorted, 7 to a line, 128 px each."""
    from PIL import Image

    models = sorted({o["model"] for o in _index()["objects"] if "model" in o})
    im = Image.open(os.path.join(EARTH, "sent-thumbs-v1.webp"))
    assert im.size == (7 * 128, -(-len(models) // 7) * 128), (im.size, len(models))
    for i, m in enumerate(models):
        cell = im.convert("RGBA").crop(
            ((i % 7) * 128, (i // 7) * 128, (i % 7) * 128 + 128, (i // 7) * 128 + 128)
        )
        assert cell.getchannel("A").getbbox(), "the cell of %s is empty" % m


def test_every_tracked_row_has_a_finite_position_today_and_where_its_table_runs_in_2030():
    """A tracked row's place is its Horizons table's (Hermite between samples): finite whenever the date is inside the table. A
    table that ends before 2030 says so: such a row reads "Position unknown" then, it is never extrapolated.
    """
    import math

    tracks = _load("space-tracks-v1.json")["tracks"]
    jd = (
        lambda y, m, d: 367 * y
        - (7 * (y + (m + 9) // 12)) // 4
        + (275 * m) // 9
        + d
        + 1721013.5
    )

    def at(track, t):
        s = track["s"]
        if not track["jd0"] <= t <= track["jd1"]:
            return None
        lo = max(i for i in range(len(s) - 1) if s[i][0] <= t)
        a, b = s[lo], s[lo + 1]
        h = b[0] - a[0]
        u = (t - a[0]) / h
        h00, h10, h01, h11 = (
            2 * u**3 - 3 * u**2 + 1,
            u**3 - 2 * u**2 + u,
            -2 * u**3 + 3 * u**2,
            u**3 - u**2,
        )
        return [
            h00 * a[1 + k] + h10 * h * a[4 + k] + h01 * b[1 + k] + h11 * h * b[4 + k]
            for k in range(3)
        ]

    today, y2030 = jd(2026, 11, 12), jd(2030, 1, 1)
    ended_before_2030 = []
    for o in _index()["objects"]:
        if o["state"] not in ("tracked", "leaving"):
            continue
        tr = tracks[o["where"]["track"]]
        p = at(tr, today)
        assert p is not None and all(math.isfinite(v) for v in p), (
            o["id"],
            "no position today",
        )
        q = at(tr, y2030)
        if q is None:
            ended_before_2030.append(o["id"])
            assert tr["jd1"] < y2030, o["id"]
        else:
            assert all(math.isfinite(v) for v in q), o["id"]
    assert set(ended_before_2030) <= {
        "psyche",
        "hayabusa2",
        "jwst",
        "juno",
        "parker",
    }, ended_before_2030


def test_every_orbiting_row_is_at_a_world_the_view_can_place():
    """An orbiting row (but the ISS, whose elements the view carries) is at a world; where in its orbit is not claimed."""
    for o in _index()["objects"]:
        if o["state"] == "orbiting" and not o["where"].get("iss"):
            assert o["where"]["body"] in ORBIT_BODIES, o["id"]


def test_a_retired_rows_table_ends_the_day_it_was_switched_off_and_its_words_exist_in_every_language():
    """A held table runs to the retirement date (a day either way of the row's `last`), and the words a retired row uses are in all ten languages."""
    tracks = _load("space-tracks-v1.json")["tracks"]
    jd = (
        lambda y, m, d: 367 * y
        - (7 * (y + (m + 9) // 12)) // 4
        + (275 * m) // 9
        + d
        + 1721013.5
    )
    for o in _index()["objects"]:
        if o["state"] != "retired":
            continue
        y, m, d = (int(x) for x in o["where"]["last"].split("-"))
        assert abs(tracks[o["where"]["track"]]["jd1"] - jd(y, m, d)) <= 1.5, o["id"]
        for lang in ("ar", "de", "en", "es", "fr", "he", "hi", "pt", "ru", "zh"):
            words = _load_i18n(lang)
            for key in (
                "sent_retired",
                "sent_h_retired",
                "alm_bi_mission_" + o["id"],
                "alm_blurb_" + o["id"],
            ):
                assert words.get(key), (lang, key)


def _load_i18n(lang):
    return words(lang)


def test_a_mass_where_given_is_a_whole_number_of_kilograms():
    """A craft's sheet shows its mass ("like their mass, when they went up, age"): `kg`, where the row has it, as published."""
    for o in _index()["objects"]:
        if "kg" in o:
            assert isinstance(o["kg"], int) and 1 <= o["kg"] <= 500_000, o["id"]
    assert _index()["objects"][0]["id"] == "iss" and "kg" in _index()["objects"][0]
