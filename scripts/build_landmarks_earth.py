"""Build the Earth's natural and human features for the 3D view: ranges, peaks, rivers, lakes, seas, deserts, islands, capes, cities.

    python scripts/build_landmarks_earth.py [--cache DIR] [--refresh] [--max-rank N]

Writes, beside landmarks-v1.json (whose ``earth`` list keeps the hand-checked places):
  zimi/static/earth/landmarks-earth-v1.json            rows [name, lat, lon, kind, qid, size_km, src, fame, rank]
  zimi/static/earth/landmarks-earth-names-<lang>-v1.json   one list per language, parallel to the rows: the name in
                                                       that language, "" where Natural Earth has none (the English
                                                       name is shown)

``rank`` is Natural Earth's own label zoom (min_zoom / min_label): the zoom a web map first names the feature. The 3D
view turns it into a distance (almanac-earth.js, AE_LM_RANK_KM) so each zoom shows a handful of names, never a clutter.
``fame`` is the number of Wikipedias that have an article (the same measure landmarks-v1.json uses); 0 without a Q-ID.

Source: Natural Earth (naturalearthdata.com), public domain, vector release 5.1.2 as GeoJSON from
github.com/nvkelso/natural-earth-vector: geography_regions_polys, geography_regions_points,
geography_regions_elevation_points, geography_marine_polys, lakes, rivers_lake_centerlines, populated_places.
The downloads are data only and are kept in the cache directory (default build/landmarks-earth-cache), never run.
Wikidata (CC0) supplies the Wikipedia counts for ``fame`` (build_landmarks.sitelink_counts).
"""

import argparse
import hashlib
import re
import urllib.parse
import json
import math
import os
import shutil
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_landmarks as base  # noqa: E402  (the Wikipedia count and the cache download are shared)

ROOT = base.ROOT
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
OUT = os.path.join(EARTH, "landmarks-earth-v1.json")
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_%s.geojson"
LANGS = [
    "ar",
    "de",
    "es",
    "fr",
    "he",
    "hi",
    "pt",
    "ru",
    "zh",
]  # English is the row's own name
FIELDS = ["name", "lat", "lon", "kind", "qid", "size_km", "src", "fame", "rank"]
SOURCE = "Natural Earth 5.1.2 (public domain), https://www.naturalearthdata.com/; Wikipedia counts from Wikidata (CC0)"
KM_PER_DEG = 111.195
DEDUPE_KM = 20.0
LAKE_WORD = re.compile(r"\b(lake|lago|lac|loch|sea|reservoir|lagoon|pond|bay)\b|lake$", re.I)

# Natural Earth's feature classes as the kinds the 3D view's cards name (AE_LM_KINDS in almanac-earth.js).
REGION_KINDS = {
    "Range/mtn": "range",
    "Desert": "desert",
    "Island": "island",
    "Island group": "island",
    "Pen/cape": "cape",
    "Peninsula": "cape",
    "Isthmus": "cape",
    "Plateau": "highland",
    "Foothills": "highland",
    "Plain": "plain",
    "Lowland": "plain",
    "Delta": "plain",
    "Basin": "plain",
    "Wetlands": "plain",
    "Tundra": "plain",
    "Depression": "valley",
    "Valley": "valley",
    "Gorge": "valley",
    "Continent": "region",
}
POINT_KINDS = {
    "island": "island",
    "island group": "island",
    "cape": "cape",
    "waterfall": "wonder",
    "pole": "region",
    "plain": "plain",
}
MARINE_KINDS = {
    "ocean": "ocean",
    "sea": "sea",
    "gulf": "bay",
    "bay": "bay",
    "sound": "bay",
    "lagoon": "bay",
    "fjord": "bay",
    "inlet": "bay",
    "strait": "strait",
    "channel": "strait",
}
LAYERS = [
    "geography_regions_polys",
    "geography_regions_points",
    "geography_regions_elevation_points",
    "geography_marine_polys",
    "lakes",
    "rivers_lake_centerlines",
    "populated_places",
]


def fetch(layer, cache):
    return json.loads(
        base._get(NE % layer, cache, "ne_10m_%s.geojson" % layer, "application/json")
    )["features"]


def lower(props):
    return {k.lower(): v for k, v in props.items()}


def num(v, default=99.0):
    try:
        v = float(v)
        return v if v == v else default
    except (TypeError, ValueError):
        return default


def rings(geom):
    """Every exterior ring of a polygon geometry, as [(lon, lat)]."""
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    return [p[0] for p in geom["coordinates"]]


def unwrap(pts):
    """Longitudes continued across the antimeridian, so a ring that crosses it is one shape."""
    out, prev = [], None
    for lon, lat in pts:
        if prev is not None:
            while lon - prev > 180:
                lon -= 360
            while lon - prev < -180:
                lon += 360
        out.append((lon, lat))
        prev = lon
    return out


def wrap(lon):
    return (lon + 180) % 360 - 180


def poly_label(geom):
    """The label point (lat, lon) and the extent in km of the polygon's biggest ring: its centroid, or its bounding-box
    centre when the centroid falls outside the box's middle half (a crescent)."""
    best = None
    for ring in rings(geom):
        pts = unwrap(ring)
        a = 0.0
        cx = cy = 0.0
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            w = x0 * y1 - x1 * y0
            a += w
            cx += (x0 + x1) * w
            cy += (y0 + y1) * w
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bx, by = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        if abs(a) > 1e-12:
            cx, cy = cx / (3 * a), cy / (3 * a)
        else:
            cx, cy = bx, by
        wdeg, hdeg = max(xs) - min(xs), max(ys) - min(ys)
        if abs(cx - bx) > wdeg / 4 or abs(cy - by) > hdeg / 4:
            cx, cy = bx, by
        area = abs(a) / 2
        if best is None or area > best[0]:
            km = math.hypot(wdeg * math.cos(math.radians(cy)), hdeg) * KM_PER_DEG
            best = (area, cy, wrap(cx), km)
    return best[1], best[2], best[3]


def line_label(geom):
    """The midpoint (lat, lon) along a river's longest piece and the river's whole length in km."""
    parts = [
        unwrap(p)
        for p in (
            geom["coordinates"]
            if geom["type"] == "MultiLineString"
            else [geom["coordinates"]]
        )
    ]

    def length(p):
        return (
            sum(
                math.hypot(
                    (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2)),
                    b[1] - a[1],
                )
                for a, b in zip(p, p[1:])
            )
            * KM_PER_DEG
        )

    total = sum(length(p) for p in parts)
    parts = [q for q in parts if len(q) > 1]
    if not parts:
        return None
    longest = max(parts, key=length)
    half, run = length(longest) / 2, 0.0
    for a, b in zip(longest, longest[1:]):
        seg = length([a, b])
        if run + seg >= half and seg > 0:
            t = (half - run) / seg
            return a[1] + (b[1] - a[1]) * t, wrap(a[0] + (b[0] - a[0]) * t), total
        run += seg
    return longest[0][1], wrap(longest[0][0]), total


def names_of(p):
    """(English name, {lang: name}) with a language kept only where it differs from the English."""
    en = (p.get("name_en") or p.get("name") or "").strip()
    loc = {}
    for lang in LANGS:
        v = (p.get("name_" + lang) or "").strip()
        if v and v != en:
            loc[lang] = v
    return en, loc


def candidates(cache, max_rank):
    out = []

    def add(p, lat, lon, kind, size, rank):
        en, loc = names_of(p)
        if not en or rank > max_rank:
            return
        qid = (p.get("wikidataid") or "").strip()
        out.append(
            {
                "row": [
                    en,
                    round(lat, 3),
                    round(lon, 3),
                    kind,
                    qid if qid.startswith("Q") else "",
                    int(round(size)),
                    0,
                    0,
                    round(rank, 1),
                ],
                "loc": loc,
            }
        )

    for f in fetch("geography_regions_polys", cache):
        p = lower(f["properties"])
        kind = REGION_KINDS.get(p.get("featurecla"))
        if kind:
            lat, lon, km = poly_label(f["geometry"])
            add(p, lat, lon, kind, km, num(p.get("min_label")))
    for f in fetch("geography_regions_points", cache):
        p = lower(f["properties"])
        kind = POINT_KINDS.get(p.get("featurecla"))
        if kind:
            lon, lat = f["geometry"]["coordinates"][:2]
            add(p, lat, lon, kind, 0, num(p.get("min_zoom")))
    for f in fetch("geography_regions_elevation_points", cache):
        p = lower(f["properties"])
        if p.get("featurecla") == "mountain":
            lon, lat = f["geometry"]["coordinates"][:2]
            add(p, lat, lon, "mons", 0, num(p.get("min_zoom")))
    for f in fetch("geography_marine_polys", cache):
        p = lower(f["properties"])
        kind = MARINE_KINDS.get(p.get("featurecla"))
        if kind:
            lat, lon, km = poly_label(f["geometry"])
            add(p, lat, lon, kind, km, num(p.get("min_label")))
    for f in fetch("lakes", cache):
        p = lower(f["properties"])
        if p.get("name"):
            lat, lon, km = poly_label(f["geometry"])
            add(p, lat, lon, "lake", km, num(p.get("min_zoom")))
    rivers = {}   # name -> [properties, label lat, label lon, longest piece's km, whole length km]
    for f in fetch("rivers_lake_centerlines", cache):
        p = lower(f["properties"])
        if p.get("featurecla") == "River" and p.get("name"):
            got = line_label(f["geometry"])
            if not got:
                continue
            lat, lon, km = got
            r = rivers.setdefault(names_of(p)[0], [p, lat, lon, 0.0, 0.0])
            r[4] += km
            if km > r[3]:
                r[1], r[2], r[3] = lat, lon, km   # the label sits on the longest piece
    for p, lat, lon, _, km in rivers.values():
        add(p, lat, lon, "river", km, num(p.get("min_zoom")))
    for f in fetch("populated_places", cache):
        p = lower(f["properties"])
        if p.get("featurecla") in (
            "Scientific station",
            "Historic place",
            "Meteorological Station",
        ):
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        add(p, lat, lon, "city", 0, num(p.get("min_zoom")))
    return out


def wikidata_labels(qids, cache):
    """{qid: English label} from Wikidata (CC0), cached like the Wikipedia counts."""
    out = {}
    qids = sorted(set(q for q in qids if q))
    for i in range(0, len(qids), 50):
        part = qids[i : i + 50]
        url = base.WD_API + "?" + urllib.parse.urlencode(
            {"action": "wbgetentities", "ids": "|".join(part), "props": "labels", "languages": "en", "format": "json"}
        )
        name = "label-" + hashlib.md5("|".join(part).encode()).hexdigest()[:12] + ".json"
        for q, ent in json.loads(base._get(url, cache, name, "application/json")).get("entities", {}).items():
            label = ent.get("labels", {}).get("en", {}).get("value")
            if label:
                out[q] = label
    return out


def name_lakes(cands, cache):
    """Natural Earth names a lake "Superior"; the English name is Wikidata's label ("Lake Superior"), or "Lake X"."""
    lakes = [c for c in cands if c["row"][3] == "lake"]
    labels = wikidata_labels([c["row"][4] for c in lakes], cache)
    for c in lakes:
        r = c["row"]
        r[0] = labels.get(r[4]) or (r[0] if LAKE_WORD.search(r[0]) else "Lake " + r[0])


def km_between(a, b):
    dlat = a[1] - b[1]
    dlon = abs(a[2] - b[2])
    dlon = min(dlon, 360 - dlon) * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot(dlat, dlon) * KM_PER_DEG


def dedupe(cands, kept_rows):
    """Drop a repeat of a name within DEDUPE_KM (the lower rank, then the better known, stays), and anything the
    hand-checked list already has (same Q-ID or same name)."""
    have_q = {r[4] for r in kept_rows if r[4]}
    have_n = {r[0].lower() for r in kept_rows}
    cands = sorted(cands, key=lambda c: (c["row"][8], -c["row"][7], c["row"][0]))
    out, by_name = [], {}
    for c in cands:
        r = c["row"]
        if (r[4] and r[4] in have_q) or r[0].lower() in have_n:
            continue
        if any(
            km_between(r, o["row"]) < DEDUPE_KM for o in by_name.get(r[0].lower(), [])
        ):
            continue
        by_name.setdefault(r[0].lower(), []).append(c)
        out.append(c)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--cache", default=os.path.join(ROOT, "build", "landmarks-earth-cache")
    )
    ap.add_argument(
        "--refresh",
        action="store_true",
        help="empty the cache first: download everything again",
    )
    ap.add_argument(
        "--max-rank",
        type=float,
        default=5.9,
        help="keep features Natural Earth labels at this zoom or lower",
    )
    a = ap.parse_args(argv)
    if a.refresh:
        shutil.rmtree(a.cache, ignore_errors=True)
    with open(os.path.join(EARTH, "landmarks-v1.json"), encoding="utf-8") as f:
        curated = json.load(f)["earth"]
    cands = candidates(a.cache, a.max_rank)
    name_lakes(cands, a.cache)
    cands = dedupe(cands, curated)
    fame = base.sitelink_counts([c["row"][4] for c in cands], a.cache)
    for c in cands:
        c["row"][7] = fame.get(c["row"][4], 0)
    cands.sort(key=lambda c: (c["row"][8], -c["row"][7], c["row"][0]))
    doc = {
        "version": 1,
        "fields": FIELDS,
        "sources": [SOURCE],
        "earth": [c["row"] for c in cands],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("%s: %d rows, %d bytes" % (OUT, len(cands), os.path.getsize(OUT)))
    for lang in LANGS:
        names = [n if n != c["row"][0] else "" for c in cands for n in [c["loc"].get(lang, "")]]
        path = os.path.join(EARTH, "landmarks-earth-names-%s-v1.json" % lang)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(names, f, ensure_ascii=False, separators=(",", ":"))
        print(
            "%s: %d named, %d bytes"
            % (
                os.path.basename(path),
                sum(1 for n in names if n),
                os.path.getsize(path),
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
