"""Build zimi/static/earth/landmarks-v1.json: named places on each body, at their true coordinates.

    python scripts/build_landmarks.py [--cache DIR]

One list per body, each row ``[name, lat, lon, kind, qid, size_km, src]`` (planetocentric latitude, longitude east,
-180..180, in the frame the body's map is drawn in; ``qid`` "" when Wikidata has none; ``size_km`` 0 for a point;
``src`` an index into the file's ``sources`` list). The 3D view (almanac-earth.js) labels them as the view comes close
enough to read them, links each to its article through its Q-ID (almanac-links.js), and flies to any of them. A body is
a key, so every body beside the Moon is a list of its own in the same file; a path (a rover's traverse) will be its own
kind with a list of points.

Sources (the ``sources`` list in the file says which row came from which):
  The IAU Gazetteer of Planetary Nomenclature (USGS Astrogeology), every body's named features: public domain.
  Wikidata (CC0): each feature's Q-ID by its Gazetteer ID (P2824); a site's by its English Wikipedia title.
  Landing sites: the landers' published coordinates (NASA NSSDC and mission pages, the LRO camera team, CNSA, ISRO,
  JAXA, ESA), here; Earth's places: their published coordinates, each checked against Wikidata's.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import struct
import sys
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "earth", "landmarks-v1.json")
UA = "Zimi-build/1.0 (https://github.com/epheterson/Zimi)"
GAZETTEER = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/%s_nomenclature_center_pts.zip"
SPARQL = "https://query.wikidata.org/sparql"
WD_API = "https://www.wikidata.org/w/api.php"
FIELDS = ["name", "lat", "lon", "kind", "qid", "size_km", "src"]

# Where each row came from: an index into the file's "sources".
SRC_GAZETTEER, SRC_MOON, SRC_MARS, SRC_VENUS, SRC_TITAN, SRC_EARTH = range(6)
SOURCES = [
    "IAU Gazetteer of Planetary Nomenclature, USGS Astrogeology Science Center (public domain), https://planetarynames.wr.usgs.gov/",
    "Lunar landers: published coordinates, NASA NSSDC and the LRO camera team (ASU), CNSA, ISRO, JAXA",
    "Mars landers and rovers: NASA/JPL mission pages and NASA NSSDC; Zhurong from CNSA and MRO HiRISE",
    "Venus landers: the Venera and Vega landing sites as published by NASA NSSDC",
    "Huygens landing site: ESA and NASA Cassini-Huygens mission pages",
    "Earth: published coordinates of each place, checked against Wikidata (CC0)",
]

# The Moon's Gazetteer codes kept, as the kinds the view knows; craters only from this diameter.
MOON_KINDS = {
    "ME": "mare",
    "OC": "mare",
    "SI": "sinus",
    "LC": "lacus",
    "PA": "palus",
    "MO": "mons",
    "VA": "vallis",
    "ST": "statio",
    "LF": "landing_feature",
    "AA": "crater",
    "PR": "promontorium",
    "RU": "rupes",
    "CA": "catena",
}
# Every other body: the feature types (Gazetteer codes) kept, as one small set of kinds a card can name in any language.
# Left out: cavi, serpentes, lingulae, labes, virgae and the rest too small or too unlike a place to be named on a globe.
PLANET_KINDS = {
    "AA": "crater",
    "LG": "crater",
    "MO": "mons",
    "CO": "mons",
    "PE": "volcano",
    "TH": "volcano",
    "ER": "volcano",
    "PL": "plain",
    "PA": "plain",
    "VS": "plain",
    "PM": "highland",
    "TA": "highland",
    "TE": "highland",
    "MN": "highland",
    "RE": "region",
    "AL": "region",
    "MA": "region",
    "FA": "region",
    "CR": "region",
    "FL": "region",
    "UN": "region",
    "CH": "region",
    "IN": "region",
    "LU": "region",
    "AR": "region",
    "VA": "valley",
    "CM": "valley",
    "FO": "valley",
    "LB": "valley",
    "SU": "valley",
    "FM": "valley",
    "RU": "ridge",
    "DO": "ridge",
    "LI": "ridge",
    "SC": "ridge",
    "FR": "ridge",
    "FE": "ridge",
    "CA": "chain",
    "ME": "sea",
    "LC": "sea",
    "SI": "sea",
    "FT": "sea",
}

# Per body: the Gazetteer file, its Wikidata item, the smallest crater and the smallest other feature kept (km across),
# the most rows kept (largest first), and the names kept whatever their size.
BODIES = {
    "moon": dict(file="MOON", wd="Q405", crater=20, other=0, kinds=MOON_KINDS),
    "mercury": dict(
        file="MERCURY",
        wd="Q308",
        crater=150,
        other=250,
        cap=100,
        pins=[
            "Caloris Planitia",
            "Hun Kal",
            "Rachmaninoff",
            "Tolstoj",
            "Beethoven",
            "Raditladi",
            "Kuiper",
            "Rembrandt",
        ],
    ),
    "venus": dict(
        file="VENUS",
        wd="Q313",
        crater=60,
        other=1500,
        cap=130,
        pins=[
            "Maxwell Montes",
            "Ishtar Terra",
            "Aphrodite Terra",
            "Maat Mons",
            "Sif Mons",
            "Beta Regio",
            "Alpha Regio",
            "Lakshmi Planum",
            "Artemis Corona",
            "Atla Regio",
            "Lada Terra",
            "Sedna Planitia",
            "Bell Regio",
        ],
    ),
    "mars": dict(
        file="MARS",
        wd="Q111",
        crater=170,
        other=900,
        cap=200,
        pins=[
            "Olympus Mons",
            "Valles Marineris",
            "Hellas Planitia",
            "Jezero",
            "Gale",
            "Arsia Mons",
            "Pavonis Mons",
            "Ascraeus Mons",
            "Elysium Mons",
            "Alba Mons",
            "Argyre Planitia",
            "Isidis Planitia",
            "Utopia Planitia",
            "Chryse Planitia",
            "Acidalia Planitia",
            "Amazonis Planitia",
            "Syrtis Major Planum",
            "Tharsis Tholus",
            "Noctis Labyrinthus",
            "Hecates Tholus",
            "Arabia Terra",
            "Terra Sirenum",
            "Terra Cimmeria",
            "Terra Sabaea",
            "Meridiani Planum",
            "Gusev",
            "Eberswalde",
            "Holden",
            "Endeavour",
            "Victoria",
            "Eagle",
            "Mawrth Vallis",
            "Kasei Valles",
            "Ares Vallis",
            "Maja Valles",
            "Tiu Valles",
            "Planum Boreum",
            "Planum Australe",
            "Melas Chasma",
            "Candor Chasma",
            "Ophir Chasma",
            "Coprates Chasma",
            "Ius Chasma",
        ],
    ),
    "io": dict(
        file="IO",
        wd="Q3123",
        crater=0,
        other=170,
        cap=40,
        pins=[
            "Loki Patera",
            "Pele",
            "Prometheus",
            "Tvashtar Paterae",
            "Pillan Patera",
            "Amirani",
            "Culann Patera",
            "Ra Patera",
            "Tohil Mons",
            "Boosaule Montes",
            "Euboea Montes",
            "Colchis Regio",
            "Bosphorus Regio",
            "Babbar Patera",
            "Marduk",
            "Masubi",
            "Zamama",
            "Dazhbog Patera",
        ],
    ),
    "europa": dict(
        file="EUROPA",
        wd="Q3143",
        crater=20,
        other=300,
        cap=45,
        pins=[
            "Tyre",
            "Pwyll",
            "Conamara Chaos",
            "Callanish",
            "Taliesin",
            "Thera Macula",
            "Thrace Macula",
            "Murias Chaos",
            "Agenor Linea",
            "Argadnel Regio",
            "Annwn Regio",
            "Falga Regio",
            "Cilix",
            "Manannan",
            "Powys Regio",
            "Minos Linea",
            "Rhadamanthys Linea",
            "Belus Linea",
        ],
    ),
    "ganymede": dict(
        file="GANYMEDE",
        wd="Q3169",
        crater=100,
        other=1800,
        cap=45,
        pins=[
            "Galileo Regio",
            "Marius Regio",
            "Barnard Regio",
            "Nicholson Regio",
            "Perrine Regio",
            "Gula",
            "Tros",
            "Osiris",
            "Gilgamesh",
            "Memphis Facula",
            "Uruk Sulcus",
            "Anat",
            "Achelous",
            "Melkart",
            "Enki Catena",
            "Nergal",
            "Tiamat Sulcus",
            "Dardanus Sulcus",
        ],
    ),
    "callisto": dict(
        file="CALLISTO",
        wd="Q3134",
        crater=80,
        other=300,
        cap=30,
        pins=[
            "Valhalla",
            "Asgard",
            "Adlinda",
            "Heimdall",
            "Lofn",
            "Har",
            "Bran",
            "Tindr",
            "Doh",
            "Gipul Catena",
            "Utgard",
            "Burr",
            "Nidi",
            "Svol Catena",
        ],
    ),
    "titan": dict(
        file="TITAN",
        wd="Q2565",
        crater=60,
        other=300,
        cap=70,
        pins=[
            "Kraken Mare",
            "Ligeia Mare",
            "Punga Mare",
            "Xanadu",
            "Shangri La",
            "Belet",
            "Adiri",
            "Menrva",
            "Selk",
            "Sinlap",
            "Hotei Arcus",
            "Mohini Fluctus",
            "Sotra Patera",
            "Doom Mons",
            "Mithrim Montes",
            "Tui Regio",
            "Hotei Regio",
            "Fensal",
            "Aztlan",
            "Senkyo",
            "Dilmun",
            "Tsegihi",
            "Ontario Lacus",
            "Jingpo Lacus",
        ],
    ),
    "pluto": dict(
        file="PLUTO",
        wd="Q339",
        crater=0,
        other=0,
        cap=45,
        pins=[
            "Sputnik Planitia",
            "Tombaugh Regio",
            "Wright Mons",
            "Piccard Mons",
            "Hillary Montes",
            "Tenzing Montes",
            "Burney",
            "Elliot",
            "Virgil Fossae",
            "Sleipnir Fossa",
            "Kiladze",
            "Pulfrich",
        ],
    ),
    "ceres": dict(
        file="CERES",
        wd="Q596",
        crater=45,
        other=40,
        cap=55,
        pins=[
            "Occator",
            "Cerealia Facula",
            "Vinalia Faculae",
            "Ahuna Mons",
            "Kerwan",
            "Yalode",
            "Urvara",
            "Dantu",
            "Haulani",
            "Ernutet",
            "Kupalo",
            "Oxo",
            "Hanami Planum",
            "Samhain Catenae",
            "Yamor Mons",
            "Liberalia Mons",
        ],
    ),
}

# Sites the Gazetteer does not name. Landings: (name, lat, lon, English Wikipedia title for its Q-ID) -- on the Moon the
# name is the title. Earth: (name, lat, lon, kind, title). Mission sites are "landing" and Earth's are points (0 km).
MOON_LANDINGS = [
    ("Apollo 11", 0.67408, 23.47297),
    ("Apollo 12", -3.01239, -23.42157),
    ("Apollo 14", -3.64530, -17.47136),
    ("Apollo 15", 26.13222, 3.63386),
    ("Apollo 16", -8.97301, 15.50019),
    ("Apollo 17", 20.19080, 30.77168),
    ("Luna 9", 7.08, -64.37),
    ("Luna 13", 18.87, -62.05),
    ("Luna 16", -0.5137, 56.3638),
    ("Luna 17", 38.2378, -35.0017),
    ("Luna 20", 3.7863, 56.6242),
    ("Luna 21", 25.85, 30.45),
    ("Luna 24", 12.7145, 62.2129),
    ("Surveyor 1", -2.4745, -43.3394),
    ("Surveyor 3", -3.0160, -23.4180),
    ("Surveyor 5", 1.455, 23.194),
    ("Surveyor 6", 0.473, -1.427),
    ("Surveyor 7", -41.0122, -11.4775),
    ("Chang'e 3", 44.1214, -19.5116),
    ("Chang'e 4", -45.4446, 177.5991),
    ("Chang'e 5", 43.0576, -51.9161),
    ("Chang'e 6", -41.6385, -153.9852),
    ("Chandrayaan-3", -69.373, 32.319),
    ("Smart Lander for Investigating Moon", -13.316, 25.251),
    ("Blue Ghost Mission 1", 18.56, 61.81),
]
# Longitudes east, 0..360 as the missions publish them.
MARS_LANDINGS = [
    ("Viking 1", 22.27, 312.05, "Viking 1"),
    ("Viking 2", 47.64, 225.74, "Viking 2"),
    ("Mars Pathfinder", 19.33, 326.51, "Mars Pathfinder"),
    ("Spirit", -14.5718, 175.4785, "Spirit (rover)"),
    ("Opportunity", -1.9462, 354.4734, "Opportunity (rover)"),
    ("Curiosity", -4.5895, 137.4417, "Curiosity (rover)"),
    ("Perseverance", 18.4446, 77.4509, "Perseverance (rover)"),
    ("Zhurong", 25.066, 109.925, "Zhurong (rover)"),
    ("InSight", 4.502, 135.623, "InSight"),
    ("Phoenix", 68.2188, 234.2508, "Phoenix (spacecraft)"),
]
VENUS_LANDINGS = [
    ("Venera 7", -5.0, 351.0, "Venera 7"),
    ("Venera 8", -10.7, 335.25, "Venera 8"),
    ("Venera 9", 31.01, 291.64, "Venera 9"),
    ("Venera 10", 15.42, 291.51, "Venera 10"),
    ("Venera 13", -7.5, 303.0, "Venera 13"),
    ("Venera 14", -13.25, 310.0, "Venera 14"),
    ("Vega 1", 7.2, 177.8, "Vega program"),
    ("Vega 2", -6.45, 181.5, "Vega program"),
]
# 10.573 S, 192.335 W as ESA and NASA publish it (Titan's west-positive longitude): 167.665 E.
TITAN_LANDINGS = [("Huygens", -10.573, 167.665, "Huygens (spacecraft)")]
# Earth, latitude and longitude east: the highest of each continent, a few wonders, the launch sites.
EARTH_PLACES = [
    ("Mount Everest", 27.9881, 86.9250, "mons", "Mount Everest"),
    ("K2", 35.8825, 76.5133, "mons", "K2"),
    ("Kangchenjunga", 27.7025, 88.1475, "mons", "Kangchenjunga"),
    ("Denali", 63.0692, -151.0070, "mons", "Denali"),
    ("Aconcagua", -32.6532, -70.0109, "mons", "Aconcagua"),
    ("Kilimanjaro", -3.0674, 37.3556, "mons", "Mount Kilimanjaro"),
    ("Elbrus", 43.3499, 42.4453, "mons", "Mount Elbrus"),
    ("Vinson Massif", -78.5254, -85.6171, "mons", "Vinson Massif"),
    ("Puncak Jaya", -4.0833, 137.1833, "mons", "Puncak Jaya"),
    ("Mont Blanc", 45.8326, 6.8652, "mons", "Mont Blanc"),
    ("Mauna Kea", 19.8207, -155.4681, "mons", "Mauna Kea"),
    ("Mount Fuji", 35.3606, 138.7274, "mons", "Mount Fuji"),
    ("Grand Canyon", 36.1069, -112.1129, "wonder", "Grand Canyon"),
    ("Uluru", -25.3444, 131.0369, "wonder", "Uluru"),
    ("Victoria Falls", -17.9243, 25.8572, "wonder", "Victoria Falls"),
    ("Great Barrier Reef", -18.2871, 147.6992, "wonder", "Great Barrier Reef"),
    ("Challenger Deep", 11.3733, 142.5917, "wonder", "Challenger Deep"),
    ("Lake Baikal", 53.5, 108.0, "wonder", "Lake Baikal"),
    ("Giza pyramids", 29.9792, 31.1342, "wonder", "Giza pyramid complex"),
    ("Angel Falls", 5.9701, -62.5362, "wonder", "Angel Falls"),
    ("Dead Sea", 31.5, 35.5, "wonder", "Dead Sea"),
    (
        "Cape Canaveral",
        28.4889,
        -80.5778,
        "launch",
        "Cape Canaveral Space Force Station",
    ),
    ("Vandenberg", 34.7420, -120.5724, "launch", "Vandenberg Space Force Base"),
    ("Baikonur", 45.9650, 63.3050, "launch", "Baikonur Cosmodrome"),
    ("Kourou", 5.2322, -52.7693, "launch", "Guiana Space Centre"),
    ("Jiuquan", 40.9581, 100.2914, "launch", "Jiuquan Satellite Launch Center"),
    ("Wenchang", 19.6145, 110.9510, "launch", "Wenchang Space Launch Site"),
    ("Tanegashima", 30.4000, 130.9700, "launch", "Tanegashima Space Center"),
    ("Sriharikota", 13.7199, 80.2304, "launch", "Satish Dhawan Space Centre"),
    ("Starbase", 25.9972, -97.1560, "launch", "Starbase"),
    ("Vostochny", 51.8844, 128.3339, "launch", "Vostochny Cosmodrome"),
]
CHECK_DEG = 0.6  # a site's coordinates this far from Wikidata's are printed for a look


def _get(url, cache, name, accept="text/csv"):
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
        with (
            urllib.request.urlopen(req, timeout=180) as r,
            open(path + ".part", "wb") as f,
        ):
            f.write(r.read())
        os.replace(path + ".part", path)
    with open(path, "rb") as f:
        return f.read()


def _sparql(query, cache, name):
    url = SPARQL + "?" + urllib.parse.urlencode({"query": query})
    return list(csv.DictReader(io.StringIO(_get(url, cache, name).decode())))


def read_dbf(data):
    """Rows of a dBASE table (the shapefile's attributes) as dicts of text."""
    n = struct.unpack("<I", data[4:8])[0]
    head, rec = struct.unpack("<HH", data[8:12])
    fields, at = [], 32
    while data[at] != 0x0D:
        fields.append((data[at : at + 11].split(b"\0")[0].decode(), data[at + 16]))
        at += 32
    rows = []
    for i in range(n):
        r, pos, row = data[head + i * rec : head + (i + 1) * rec], 1, {}
        for name, size in fields:
            row[name] = r[pos : pos + size].decode("utf-8", "replace").strip()
            pos += size
        rows.append(row)
    return rows


def gazetteer_rows(cache, spec):
    name = spec["file"]
    z = zipfile.ZipFile(
        io.BytesIO(_get(GAZETTEER % name, cache, name.lower() + "-gazetteer.zip"))
    )
    return read_dbf(z.read(next(n for n in z.namelist() if n.endswith(".dbf"))))


def qids_by_gazetteer_id(cache, key, spec, wanted):
    """Wikidata items by Gazetteer ID (P2824): the body's own first, then the rest by ID for any it missed."""
    q = (
        "SELECT ?item ?id WHERE { ?item wdt:P2824 ?id . ?item wdt:P376 wd:%s . }"
        % spec["wd"]
    )
    qid = {
        r["id"]: r["item"].rsplit("/", 1)[-1]
        for r in _sparql(q, cache, key + "-qids.csv")
    }
    missing = sorted(i for i in wanted if i not in qid)
    for at in range(0, len(missing), 150):
        q = (
            "SELECT ?item ?id WHERE { VALUES ?id { %s } ?item wdt:P2824 ?id . }"
            % " ".join('"%s"' % i for i in missing[at : at + 150])
        )
        for r in _sparql(q, cache, "%s-qids-more-%d.csv" % (key, at)):
            qid.setdefault(r["id"], r["item"].rsplit("/", 1)[-1])
    return qid


def features(cache, key, spec):
    """The body's named features worth a label, largest first: [name, lat, lon, kind, qid, size_km, src]."""
    kinds, pins = spec.get("kinds", PLANET_KINDS), spec.get("pins", [])
    raw = []
    for r in gazetteer_rows(cache, spec):
        kind = kinds.get(r["code"])
        if kind and r["approval"] == "Adopted by IAU":
            lon = float(r["center_lon"])
            raw.append(
                (r, kind, float(r["diameter"] or 0), lon - 360 if lon > 180 else lon)
            )
    absent = [p for p in pins if not any(t[0]["clean_name"] == p for t in raw)]
    if absent:
        raise SystemExit("%s: pinned names not in the Gazetteer: %s" % (key, absent))

    def big_enough(t):
        floor = spec["crater"] if t[1] == "crater" else spec["other"]
        return t[2] >= floor and (t[2] > 0 or not floor)

    keep = sorted(
        (t for t in raw if t[0]["clean_name"] in pins or big_enough(t)),
        key=lambda t: (t[0]["clean_name"] not in pins, -t[2]),
    )
    if spec.get("cap"):
        keep = keep[
            : max(spec["cap"], sum(1 for t in keep if t[0]["clean_name"] in pins))
        ]
    fid = lambda t: t[0]["link"].rsplit("/", 1)[-1]
    qid = qids_by_gazetteer_id(cache, key, spec, {fid(t) for t in keep})
    out, seen = [], set()
    for t in sorted(keep, key=lambda t: -t[2]):
        r, kind, size, lon = t
        if r["clean_name"] in seen:
            continue
        seen.add(r["clean_name"])
        out.append(
            [
                r["clean_name"],
                round(float(r["center_lat"]), 4),
                round(lon, 4),
                kind,
                qid.get(fid(t), ""),
                round(size, 1),
                SRC_GAZETTEER,
            ]
        )
    return out


def wikidata_by_title(titles, cache):
    """English Wikipedia title -> (Q-ID, (lat, lon) or None), from Wikidata (CC0)."""
    out = {}
    for i in range(0, len(titles), 40):
        part = titles[i : i + 40]
        url = (
            WD_API
            + "?"
            + urllib.parse.urlencode(
                {
                    "action": "wbgetentities",
                    "sites": "enwiki",
                    "titles": "|".join(part),
                    "props": "sitelinks|claims",
                    "sitefilter": "enwiki",
                    "format": "json",
                }
            )
        )
        name = (
            "titles-" + hashlib.md5("|".join(part).encode()).hexdigest()[:12] + ".json"
        )
        data = json.loads(_get(url, cache, name, "application/json"))
        for q, ent in data.get("entities", {}).items():
            title = ent.get("sitelinks", {}).get("enwiki", {}).get("title")
            if not (title and q.startswith("Q")):
                continue
            claims = ent.get("claims", {}).get("P625", [])
            vals = [
                c.get("mainsnak", {}).get("datavalue", {}).get("value") for c in claims
            ]
            pt = next(((v["latitude"], v["longitude"]) for v in vals if v), None)
            out[title] = (q, pt)
    return out


def _lon_gap(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def sites(cache):
    """Every body's hand-listed sites, {body: rows}, with Q-IDs; Earth's are checked against Wikidata's coordinates."""
    wanted = {
        "moon": [(n, la, lo, n, "landing", SRC_MOON) for n, la, lo in MOON_LANDINGS],
        "mars": [(n, la, lo, t, "landing", SRC_MARS) for n, la, lo, t in MARS_LANDINGS],
        "venus": [
            (n, la, lo, t, "landing", SRC_VENUS) for n, la, lo, t in VENUS_LANDINGS
        ],
        "titan": [
            (n, la, lo, t, "landing", SRC_TITAN) for n, la, lo, t in TITAN_LANDINGS
        ],
        "earth": [(n, la, lo, t, k, SRC_EARTH) for n, la, lo, k, t in EARTH_PLACES],
    }
    wd = wikidata_by_title(sorted({w[3] for ws in wanted.values() for w in ws}), cache)
    rows = {}
    for body, ws in wanted.items():
        rows[body] = []
        for name, lat, lon, title, kind, src in ws:
            q, pt = wd.get(title, ("", None))
            if not q:
                print("  no Wikidata item for %r (%s)" % (title, body))
            elif (
                pt
                and body == "earth"
                and (abs(pt[0] - lat) > CHECK_DEG or _lon_gap(pt[1], lon) > CHECK_DEG)
            ):
                print(
                    "  CHECK %s: ours %.3f,%.3f  Wikidata %.3f,%.3f"
                    % (name, lat, lon, pt[0], pt[1])
                )
            rows[body].append(
                [name, lat, round(lon - 360 if lon > 180 else lon, 4), kind, q, 0, src]
            )
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(ROOT, "build", "landmarks-cache"))
    a = ap.parse_args(argv)
    placed = sites(a.cache)
    order = [
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
    doc = {"version": 1, "fields": FIELDS, "sources": SOURCES}
    for key in order:
        feats = features(a.cache, key, BODIES[key]) if key in BODIES else []
        doc[key] = placed.get(key, []) + feats
        print(
            "%-9s %4d rows (%d sites, %d with a Q-ID)"
            % (
                key,
                len(doc[key]),
                len(placed.get(key, [])),
                sum(1 for r in doc[key] if r[4]),
            )
        )
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("%s: %d bytes" % (OUT, os.path.getsize(OUT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
