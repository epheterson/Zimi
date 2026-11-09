"""The landmarks file: every body's named places, at the coordinates their sources publish, in the frame the maps use.

Eric, 2026-11-06: "landmarks on each body would be necessary". zimi/static/earth/landmarks-v1.json holds one list per
body (scripts/build_landmarks.py). Three things are checked without a browser: the file's shape, a handful of places
per body against the coordinates the IAU Gazetteer and the missions publish, and that those places sit on the right
feature of the body's own map (the texture the 3D view draws), so a longitude that runs the wrong way, or from the wrong
meridian, fails here.

Run: pytest tests/test_landmarks_data.py -v
"""

import json
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH_DIR = os.path.join(ROOT, "zimi", "static", "earth")
BODIES = [
    "moon",
    "mars",
    "venus",
    "titan",
    "mercury",
    "earth",
    "io",
    "europa",
    "ganymede",
    "callisto",
    "pluto",
    "ceres",
]
MAX_BYTES = 200_000  # one small file, fetched when a body with landmarks is near

# (body, name, latitude, longitude east, tolerance in degrees): the coordinates people quote, not our own file's.
REFERENCE = [
    ("mars", "Olympus Mons", 18.65, 226.2, 0.3),
    ("mars", "Jezero", 18.38, 77.58, 0.3),
    ("mars", "Gale", -5.4, 137.8, 0.3),
    ("mars", "Valles Marineris", -14.0, 301.4, 0.5),
    ("mars", "Hellas Planitia", -42.4, 70.5, 0.5),
    ("mars", "Curiosity", -4.5895, 137.4417, 0.01),
    ("mars", "Perseverance", 18.4446, 77.4509, 0.01),
    ("mars", "Viking 1", 22.27, 312.05, 0.3),
    ("mars", "Phoenix", 68.2188, 234.2508, 0.01),
    ("mercury", "Caloris Planitia", 31.65, 162.0, 0.3),
    ("venus", "Maxwell Montes", 65.2, 3.3, 0.3),
    ("venus", "Venera 9", 31.01, 291.64, 0.01),
    ("titan", "Kraken Mare", 68.0, 50.0, 0.5),
    ("titan", "Huygens", -10.573, 167.665, 0.01),
    ("pluto", "Sputnik Planitia", 20.0, 175.0, 5.0),
    ("pluto", "Tombaugh Regio", 7.6, 183.2, 0.5),
    ("ceres", "Occator", 19.8, 239.3, 0.3),
    ("io", "Pele", -18.7, 104.7, 0.5),
    ("europa", "Pwyll", -25.0, 89.0, 0.5),
    ("earth", "Mount Everest", 27.99, 86.93, 0.05),
    ("earth", "Baikonur", 45.965, 63.305, 0.05),
    ("earth", "Kourou", 5.232, -52.77, 0.05),
    ("moon", "Apollo 11", 0.674, 23.473, 0.01),
]

# Where each is on its own map, by what the picture shows there: ("bright"|"dark", the feature's name). The place's
# patch of the map must be the extreme against the same latitude under the other conventions (longitude west, the map
# centred on 180, latitude flipped): a wrong frame lands it on something else.
ON_THE_MAP = [
    ("mars", "Hellas Planitia", "bright"),
    ("mars", "Syrtis Major Planum", "dark"),
    ("venus", "Maxwell Montes", "bright"),
    ("venus", "Aphrodite Terra", "bright"),
    ("mercury", "Kuiper", "bright"),
    ("callisto", "Valhalla", "bright"),
    ("europa", "Pwyll", "bright"),
    ("ganymede", "Tros", "bright"),
    ("ganymede", "Galileo Regio", "dark"),
    ("io", "Loki Patera", "dark"),
]


@pytest.fixture(scope="module")
def data():
    with open(os.path.join(EARTH_DIR, "landmarks-v1.json"), encoding="utf-8") as f:
        return json.load(f)


def _row(data, body, name):
    return next(r for r in data[body] if r[0] == name)


def _lon_gap(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def test_one_small_file_with_every_body_and_its_sources(data):
    assert data["fields"] == [
        "name",
        "lat",
        "lon",
        "kind",
        "qid",
        "size_km",
        "src",
        "fame",
    ]
    assert len(data["sources"]) >= 6 and all(
        isinstance(s, str) and s for s in data["sources"]
    )
    assert [
        k for k in data if isinstance(data[k], list) and k not in ("fields", "sources")
    ] == BODIES
    assert os.path.getsize(os.path.join(EARTH_DIR, "landmarks-v1.json")) < MAX_BYTES
    for body in BODIES:
        names = set()
        for r in data[body]:
            assert len(r) == 8, (body, r)
            name, lat, lon, kind, qid, size, src, fame = r
            assert name and name not in names, (body, name)
            names.add(name)
            assert isinstance(fame, int) and fame >= 0, (body, r)
            assert -90 <= lat <= 90 and -180 <= lon <= 180, (body, r)
            assert re.fullmatch(r"Q\d+", qid) or qid == "", (body, r)
            assert size >= 0 and 0 <= src < len(data["sources"]), (body, r)
        assert len(data[body]) >= 25, body


def test_every_kind_is_one_the_cards_can_name(data):
    with open(
        os.path.join(ROOT, "zimi", "static", "i18n", "en.json"), encoding="utf-8"
    ) as f:
        en = json.load(f)
    js = open(
        os.path.join(ROOT, "zimi", "static", "almanac-earth.js"), encoding="utf-8"
    ).read()
    table = re.search(r"var AE_LM_KINDS = \{(.*?)\};", js, re.S).group(1)
    known = set(re.findall(r"(\w+):", table))
    used = {r[3] for b in BODIES for r in data[b]}
    assert used <= known, used - known
    for card in set(re.findall(r":\s*'(\w+)'", table)):
        assert "alm_lm_kind_" + card in en, card


def test_each_site_is_the_one_the_missions_publish(data):
    for body, name, lat, lon, tol in REFERENCE:
        r = _row(data, body, name)
        assert abs(r[1] - lat) <= tol and _lon_gap(r[2], lon) <= tol, (
            body,
            name,
            r,
            lat,
            lon,
        )


def test_every_body_has_the_places_that_were_asked_for(data):
    want = {
        "mars": [
            "Olympus Mons",
            "Valles Marineris",
            "Hellas Planitia",
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
            "Jezero",
            "Gale",
        ],
        "mercury": ["Caloris Planitia"],
        "venus": ["Maxwell Montes", "Ishtar Terra", "Aphrodite Terra", "Venera 13"],
        "titan": ["Huygens", "Kraken Mare"],
        "pluto": ["Sputnik Planitia", "Tombaugh Regio"],
        "ceres": ["Occator"],
        "earth": ["Mount Everest", "Cape Canaveral", "Baikonur", "Kourou"],
        "moon": ["Apollo 11", "Apollo 17"],
    }
    for body, names in want.items():
        have = {r[0] for r in data[body]}
        assert set(names) <= have, (body, set(names) - have)
    for body in ("io", "europa", "ganymede", "callisto"):
        assert len([r for r in data[body] if r[3] != "landing"]) >= 5, body
    for body in BODIES:
        if body not in ("moon", "earth"):
            assert sum(1 for r in data[body] if r[4]) >= len(data[body]) * 0.9, (
                "Q-IDs: " + body
            )


def _patch(a, lat, lon, half=3):
    import numpy as np

    h, w = a.shape
    cy, cx = (90 - lat) / 180 * h, ((lon + 180) % 360) / 360 * w
    ry, rx = max(1, int(half / 180 * h)), max(1, int(half / 360 * w))
    ys = np.clip(np.arange(int(cy) - ry, int(cy) + ry + 1), 0, h - 1)
    xs = np.arange(int(cx) - rx, int(cx) + rx + 1) % w
    return float(a[np.ix_(ys, xs)].mean())


def test_places_sit_on_their_own_maps(data):
    import numpy as np
    Image = pytest.importorskip("PIL.Image")
    for body, name, kind in ON_THE_MAP:
        a = np.asarray(
            Image.open(os.path.join(EARTH_DIR, body + "-v1.webp")).convert("L"),
            dtype=float,
        )
        _, lat, lon = _row(data, body, name)[:3]
        here = _patch(a, lat, lon)
        others = {
            "west": _patch(a, lat, -lon),
            "centred on 180": _patch(a, lat, lon + 180),
            "flipped": _patch(a, -lat, lon),
        }
        for how, v in others.items():
            assert (here > v) if kind == "bright" else (here < v), (
                body,
                name,
                kind,
                round(here),
                how,
                round(v),
            )


def test_earth_places_are_on_land_in_the_blue_marble(data):
    import numpy as np
    Image = pytest.importorskip("PIL.Image")
    im = np.asarray(
        Image.open(os.path.join(EARTH_DIR, "earth-day-v1.webp")).convert("RGB"),
        dtype=float,
    )
    sea = np.array([3, 5, 20])

    def on_land(lat, lon):
        h, w, _ = im.shape
        x, y = int(((lon + 180) % 360) / 360 * w), int((90 - lat) / 180 * h)
        return float(np.abs(im[y, x] - sea).max()) > 12

    places = [
        r
        for r in data["earth"]
        if r[0] not in ("Challenger Deep", "Great Barrier Reef")
    ]
    here = sum(on_land(r[1], r[2]) for r in places)
    mirrored = sum(on_land(r[1], -r[2]) for r in places)
    # An island or two (Tanegashima) is under a pixel of this map; the same places mirrored are half in the sea.
    assert here >= len(places) - 3, (here, len(places))
    assert mirrored <= len(places) * 0.7, (mirrored, len(places))
