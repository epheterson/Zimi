"""Build zimi/static/earth/landmarks-v1.json: named places on each body, at their true coordinates.

    python scripts/build_landmarks.py [--cache DIR]

One list per body, each row ``[name, lat, lon, kind, qid, size_km]`` (planetocentric latitude, longitude east,
-180..180; ``qid`` "" when Wikidata has none; ``size_km`` 0 for a point). The 3D view (almanac-earth.js) labels them
as the view comes close enough to read them, links each to its article through its Q-ID (almanac-links.js), and
flies to any of them. A body is a key, so Mars and the rest slot in beside the Moon; a path (a rover's traverse)
will be its own kind with a list of points.

Sources:
  The IAU Gazetteer of Planetary Nomenclature (USGS Astrogeology), the Moon's named features: public domain.
  Wikidata (CC0): each feature's Q-ID by its Gazetteer ID (P2824); a landing's by its English Wikipedia title.
  Landing sites: the landers' published coordinates (NASA NSSDC, the LRO camera team, CNSA, ISRO, JAXA), here.
"""

import argparse
import csv
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
GAZETTEER = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip"
SPARQL = "https://query.wikidata.org/sparql"
WD_API = "https://www.wikidata.org/w/api.php"

# The Gazetteer's feature codes kept, as the kinds the view knows; craters only from this diameter.
KINDS = {
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
CRATER_MIN_KM = 20

# Landings that touched down working, with the English Wikipedia title that names each (for its Q-ID).
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


def _get(url, cache, name):
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept": "text/csv"}
        )
        with (
            urllib.request.urlopen(req, timeout=180) as r,
            open(path + ".part", "wb") as f,
        ):
            f.write(r.read())
        os.replace(path + ".part", path)
    with open(path, "rb") as f:
        return f.read()


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


def moon_features(cache):
    z = zipfile.ZipFile(io.BytesIO(_get(GAZETTEER, cache, "moon-gazetteer.zip")))
    dbf = next(n for n in z.namelist() if n.endswith(".dbf"))
    q = "SELECT ?item ?id WHERE { ?item wdt:P2824 ?id . ?item wdt:P376 wd:Q405 . }"
    text = _get(
        SPARQL + "?" + urllib.parse.urlencode({"query": q}), cache, "moon-qids.csv"
    ).decode()
    qid = {
        row["id"]: row["item"].rsplit("/", 1)[-1]
        for row in csv.DictReader(io.StringIO(text))
    }
    out = []
    for r in read_dbf(z.read(dbf)):
        kind = KINDS.get(r["code"])
        size = float(r["diameter"] or 0)
        if (
            not kind
            or r["approval"] != "Adopted by IAU"
            or (kind == "crater" and size < CRATER_MIN_KM)
        ):
            continue
        lon = float(r["center_lon"])
        lon = lon - 360 if lon > 180 else lon
        fid = r["link"].rsplit("/", 1)[-1]
        out.append(
            [
                r["clean_name"],
                round(float(r["center_lat"]), 4),
                round(lon, 4),
                kind,
                qid.get(fid, ""),
                round(size, 1),
            ]
        )
    return out


def qids_by_title(titles, cache):
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
                    "props": "sitelinks",
                    "sitefilter": "enwiki",
                    "format": "json",
                }
            )
        )
        data = json.loads(_get(url, cache, "landings-%d.json" % i))
        for q, ent in data.get("entities", {}).items():
            title = ent.get("sitelinks", {}).get("enwiki", {}).get("title")
            if title and q.startswith("Q"):
                out[title] = q
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(ROOT, "build", "landmarks-cache"))
    a = ap.parse_args(argv)
    q = qids_by_title([t for t, _, _ in MOON_LANDINGS], a.cache)
    landings = [[t, la, lo, "landing", q.get(t, ""), 0] for t, la, lo in MOON_LANDINGS]
    moon = landings + sorted(moon_features(a.cache), key=lambda r: -r[5])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(
            {
                "version": 1,
                "fields": ["name", "lat", "lon", "kind", "qid", "size_km"],
                "moon": moon,
            },
            f,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    print(
        "%s: moon %d (%d landings, %d with a Q-ID)"
        % (OUT, len(moon), len(landings), sum(1 for r in moon if r[4]))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
