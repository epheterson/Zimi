#!/usr/bin/env python3
"""Build zimi/assets/map-regions.json: what ground each catalog map covers.

The catalog knows a map by name and size, not by where it is. The map's own
config (its true bounds) is inside the ZIM, unreadable until downloaded. So
for the question "which maps in the catalog cover the spot on screen?" Zimi
ships a table of approximate boxes, [W, S, E, N], one per catalog map:

- Kiwix's maps2zim regions (maps_en_<region>) are countries, matched by title
  against Natural Earth's admin-0 boundaries (public domain), through the
  datasets/geo-countries GeoJSON. Multi-country regions (Balkans, Nordics,
  Gulf States...) are the union of their countries; continents and a few
  oddities are boxes written by hand below.
- StreetZim's regions are written by hand: many are not places a geocoder
  knows ("central-us", "korea-mongolia"), and the ones that are came back
  from Nominatim as a bistro in Brno for "southeast-asia". Approximate on
  purpose: the box decides which maps to offer, and the map's own config is
  the truth once it is installed.

A box with W > E crosses the antimeridian (Russia, the Pacific).

Usage: python3 scripts/build_map_regions.py [countries.geojson]
  Downloads the GeoJSON (14 MB) when no path is given. Prints every catalog
  map it could not place; add an alias or a box and run again.
"""

import datetime
import glob
import gzip
import json
import os
import re
import sys
import unicodedata
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "zimi", "assets")
OUT = os.path.join(ASSETS, "map-regions.json")
GEOJSON_URL = "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson"

WORLD = [-180.0, -90.0, 180.0, 90.0]

# Kiwix titles that are not a Natural Earth country name: a country under
# another name, a list of countries (their union), or a box.
KIWIX_ALIASES = {
    "maps_en_all": WORLD,
    "maps_en_myanmar-burma": "Myanmar",
    "maps_en_czech-republic": "Czechia",
    "maps_en_australia-oceania": [110.0, -50.0, -130.0, 22.0],
    "maps_en_congo-democratic-republic-kinshasa": "Democratic Republic of the Congo",
    "maps_en_congo-republic-brazzaville": "Republic of the Congo",
    "maps_en_north-america": [-170.0, 5.0, -50.0, 84.0],
    "maps_en_tanzania": "United Republic of Tanzania",
    "maps_en_south-america": [-92.0, -56.5, -34.0, 13.5],
    "maps_en_africa": [-18.0, -35.0, 52.0, 38.0],
    "maps_en_swaziland": "eSwatini",
    "maps_en_guernsey-and-jersey": ["Guernsey", "Jersey"],
    "maps_en_bahamas": "The Bahamas",
    "maps_en_russia": "Russia",
    "maps_en_israel-and-palestine": ["Israel", "Palestine"],
    "maps_en_macedonia": "North Macedonia",
    "maps_en_malaysia-singapore-and-brunei": ["Malaysia", "Singapore", "Brunei"],
    "maps_en_balkans": ["Albania", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Kosovo", "Montenegro",
                        "North Macedonia", "Republic of Serbia", "Slovenia", "Greece", "Romania"],
    "maps_en_micronesia": "Federated States of Micronesia",
    "maps_en_nordics": ["Norway", "Sweden", "Finland", "Denmark", "Iceland"],
    "maps_en_haiti-and-dominican-republic": ["Haiti", "Dominican Republic"],
    "maps_en_tokelau": [-172.6, -9.5, -171.1, -8.5],
    "maps_en_senegal-and-gambia": ["Senegal", "Gambia"],
    "maps_en_europe": [-25.0, 34.0, 45.0, 72.0],
    "maps_en_southeast-asia": [92.0, -11.5, 141.5, 28.5],
    "maps_en_wallis-et-futuna": "Wallis and Futuna",
    "maps_en_cape-verde": "Cabo Verde",
    "maps_en_canary-islands": [-18.3, 27.6, -13.3, 29.5],
    "maps_en_bosnia-herzegovina": "Bosnia and Herzegovina",
    "maps_en_serbia": "Republic of Serbia",
    "maps_en_central-america": [-92.5, 7.0, -77.0, 18.5],
    "maps_en_azores": [-31.4, 36.9, -24.9, 39.8],
    "maps_en_indonesia-with-east-timor": ["Indonesia", "East Timor"],
    "maps_en_southern-africa": [10.0, -35.5, 41.0, -8.0],  # titled "East Africa" in the catalog; it is not
    "maps_en_south-atlantic": [-62.0, -60.0, -5.0, -7.0],
    "maps_en_andes": ["Colombia", "Ecuador", "Peru", "Bolivia", "Chile", "Venezuela"],
    "maps_en_comores": "Comoros",
    "maps_en_gcc-states": ["Saudi Arabia", "United Arab Emirates", "Qatar", "Bahrain", "Kuwait", "Oman"],
    "maps_en_asia": [25.0, -11.0, 180.0, 82.0],
}

# StreetZim's 47 regions (the `osm-` names), by hand. [W, S, E, N].
STREETZIM = {
    "osm-africa": [-18.0, -35.0, 52.0, 38.0],
    "osm-alaska": [-170.0, 51.0, -129.0, 72.0],
    "osm-argentina": [-73.6, -55.2, -53.6, -21.8],
    "osm-australia-nz": [112.0, -48.0, 180.0, -9.0],
    "osm-baltics": [20.5, 53.8, 28.3, 59.8],
    "osm-brazil": [-74.0, -33.9, -28.6, 5.3],
    "osm-california": [-124.5, 32.5, -114.1, 42.0],
    "osm-carolinas": [-84.4, 32.0, -75.4, 36.6],
    "osm-caucasus": [38.5, 38.3, 50.5, 44.0],
    "osm-central-america-caribbean": [-92.5, 7.0, -59.0, 27.5],
    "osm-central-asia": [46.5, 35.0, 87.5, 55.5],
    "osm-central-us": [-104.1, 25.8, -89.0, 49.0],
    "osm-chicago-metro": [-88.9, 41.0, -87.0, 42.5],
    "osm-china": [73.5, 18.0, 134.8, 53.6],
    "osm-colorado": [-109.1, 37.0, -102.0, 41.0],
    "osm-east-africa": [28.0, -12.0, 52.0, 18.0],
    "osm-east-coast-us": [-83.5, 24.5, -66.9, 47.5],
    "osm-egypt": [24.6, 22.0, 37.2, 31.9],
    "osm-europe": [-25.0, 34.0, 45.0, 72.0],
    "osm-florida": [-87.7, 24.4, -79.9, 31.0],
    "osm-greater-la": [-119.0, 33.3, -116.9, 34.9],
    "osm-hawaii": [-178.5, 18.5, -154.5, 28.5],
    "osm-himalayas": [72.0, 26.0, 98.0, 37.0],
    "osm-hispaniola": [-74.5, 17.5, -68.3, 20.1],
    "osm-iceland": [-25.0, 63.0, -12.8, 67.4],
    "osm-indian-subcontinent": [60.0, 5.0, 98.0, 37.5],
    "osm-iran": [44.0, 24.8, 63.4, 39.8],
    "osm-japan": [122.7, 24.0, 146.0, 45.8],
    "osm-korea-mongolia": [87.5, 33.0, 131.0, 52.2],
    "osm-mexico": [-118.6, 14.4, -86.5, 32.8],
    "osm-midwest-us": [-104.1, 36.0, -80.5, 49.4],
    "osm-nyc-metro": [-75.4, 40.2, -72.7, 41.6],
    "osm-new-york-state": [-79.8, 40.5, -71.8, 45.1],
    "osm-pacific-islands": [130.0, -30.0, -130.0, 25.0],
    "osm-russia": [19.6, 41.2, -169.0, 82.1],
    "osm-silicon-valley": [-122.6, 36.9, -121.5, 37.8],
    "osm-south-america": [-92.0, -56.5, -34.0, 13.5],
    "osm-south-korea": [124.4, 32.9, 132.1, 38.7],
    "osm-southeast-asia": [92.0, -11.5, 141.5, 28.5],
    "osm-southern-africa": [10.0, -35.5, 41.0, -8.0],
    "osm-switzerland": [5.9, 45.8, 10.5, 47.9],
    "osm-texas": [-106.7, 25.8, -93.5, 36.6],
    "osm-ukraine": [22.1, 44.2, 40.3, 52.4],
    "osm-united-states": [-125.0, 24.4, -66.9, 49.4],
    "osm-washington-dc": [-77.6, 38.6, -76.6, 39.2],
    "osm-west-africa": [-18.0, 4.0, 16.0, 28.0],
    "osm-west-asia": [25.0, 12.0, 63.5, 42.5],
}


def _norm(s):
    return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower())


def _bbox(geom):
    box = [180.0, 90.0, -180.0, -90.0]

    def walk(c):
        if isinstance(c[0], (int, float)):
            box[0] = min(box[0], c[0])
            box[2] = max(box[2], c[0])
            box[1] = min(box[1], c[1])
            box[3] = max(box[3], c[1])
        else:
            for k in c:
                walk(k)

    walk(geom["coordinates"])
    return [round(v, 3) for v in box]


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def load_countries(path):
    if path:
        with open(path, encoding="utf-8") as f:
            gj = json.load(f)
    else:
        print(f"Downloading {GEOJSON_URL} ...", flush=True)
        with urllib.request.urlopen(GEOJSON_URL, timeout=120) as r:
            gj = json.load(r)
    out = {}
    for feat in gj["features"]:
        p = feat["properties"]
        name = p.get("ADMIN") or p.get("name")
        if name:
            out[name] = _bbox(feat["geometry"])
    return out


def _snapshot_items(pattern):
    paths = sorted(glob.glob(os.path.join(ASSETS, pattern)))
    if not paths:
        return []
    with gzip.open(paths[-1], "rt", encoding="utf-8") as f:
        payload = json.load(f)
    return payload.get("items") or payload.get("entries") or []


def resolve(name, title, countries, by_norm):
    alias = KIWIX_ALIASES.get(name)
    if isinstance(alias, list) and alias and isinstance(alias[0], (int, float)):
        return alias
    names = alias if isinstance(alias, list) else [alias or title]
    boxes = []
    for n in names:
        key = by_norm.get(_norm(n))
        if key is None:
            return None
        boxes.append(countries[key])
    return _union(boxes)


def main():
    countries = load_countries(sys.argv[1] if len(sys.argv) > 1 else None)
    by_norm = {_norm(k): k for k in countries}
    kiwix = {}
    missing = []
    for it in _snapshot_items("catalog-snapshot*.json.gz"):
        name = str(it.get("name") or "")
        if not name.startswith("maps_"):
            continue
        box = resolve(name, it.get("title") or "", countries, by_norm)
        if box is None:
            missing.append((name, it.get("title")))
        else:
            kiwix[name] = [round(float(v), 3) for v in box]
    streetzim = {}
    for it in _snapshot_items("streetzim-snapshot.json.gz"):
        name = str(it.get("name") or "")
        if name in STREETZIM:
            streetzim[name] = STREETZIM[name]
        else:
            missing.append((name, it.get("title")))
    payload = {
        "built_at": datetime.date.today().isoformat(),
        "note": "Approximate [W, S, E, N] per catalog map. Kiwix from Natural Earth admin-0 (public domain); StreetZim by hand. W > E crosses the antimeridian.",
        "kiwix": dict(sorted(kiwix.items())),
        "streetzim": dict(sorted(streetzim.items())),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")
    print(f"Wrote {OUT}: {len(kiwix)} Kiwix, {len(streetzim)} StreetZim ({os.path.getsize(OUT)} bytes)")
    if missing:
        print("NOT PLACED (add an alias or a box):", file=sys.stderr)
        for m in missing:
            print("  ", m, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
