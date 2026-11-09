#!/usr/bin/env python3
"""Build the region and country boundaries that ship inside Zimi, once, from
Natural Earth.

    python3 scripts/build_admin1.py [ne_10m_admin_1_states_provinces.geojson]

Writes one committed file:

    zimi/assets/admin1-snapshot.json.gz

Every first-level region of every country (4,596 states, provinces,
prefectures, counties...) as a coarse outline, so a town a map's tiles label
without saying where it is can be given its region and country offline
(zimi/regions.py, zimi/mapplaces.py). The outlines are simplified to about
3 km (Douglas-Peucker, then rounded to 0.01 degree) and are for telling
"Springfield, Illinois" from "Springfield, Missouri", not for surveying.

Natural Earth is in the public domain (see THIRD_PARTY_NOTICES.md). Without a
file argument the 10 m admin-1 file is downloaded from Natural Earth's
vector mirror. Run rarely: borders change slowly.

File format (compact on purpose):

    {"v": 1, "unit": 0.01,
     "countries": [[name, iso2], ...],
     "regions": [[name, postal, country index, [ring, ...]], ...]}

A ring is [lng0, lat0, dlng, dlat, ...]: the first point in units, every
other a step from the one before. A region's rings are tested together by
the even-odd rule, so a hole (the Vatican inside Rome) needs no flag.
"""

import gzip
import json
import math
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "assets", "admin1-snapshot.json.gz")
SOURCE = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_10m_admin_1_states_provinces.geojson"
)
UNIT = 0.01
# Douglas-Peucker tolerance, degrees (about 3 km).
TOLERANCE = 0.03
# An outer ring whose box is smaller than this in both directions (about 3 km)
# is a rock: left out unless it is all a region has. A hole is kept down to a
# unit (the rounding): the even-odd rule needs it to leave an enclave out.
MIN_RING_SPAN = 0.03

# Natural Earth's own spellings, as people write the country.
COUNTRY_NAMES = {
    "United States of America": "United States",
    "Republic of Serbia": "Serbia",
    "United Republic of Tanzania": "Tanzania",
    "The Bahamas": "Bahamas",
    "Czech Republic": "Czechia",
    "Macedonia": "North Macedonia",
    "Swaziland": "Eswatini",
    "East Timor": "Timor-Leste",
    "Guinea Bissau": "Guinea-Bissau",
    "Ivory Coast": "Cote d'Ivoire",
    "S. Sudan": "South Sudan",
    "Hong Kong S.A.R.": "Hong Kong",
    "Macau S.A.R": "Macau",
    "Federated States of Micronesia": "Micronesia",
    "Cape Verde": "Cabo Verde",
    "Vatican": "Vatican City",
    "Spratly Is.": "Spratly Islands",
    "Democratic Republic of the Congo": "DR Congo",
    "Republic of the Congo": "Congo",
}


def _perp(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(p[0] - ax, p[1] - ay)
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


def simplify(points, tol):
    """Douglas-Peucker on an open polyline, iteratively (rings are long)."""
    n = len(points)
    if n < 3:
        return list(points)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        worst, at = 0.0, -1
        for k in range(i + 1, j):
            d = _perp(points[k], points[i], points[j])
            if d > worst:
                worst, at = d, k
        if worst > tol:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(points, keep) if k]


def encode_ring(points):
    """Rounded to UNIT, repeated points dropped, as the file's delta list."""
    q = []
    for lng, lat in points:
        p = (round(lng / UNIT), round(lat / UNIT))
        if not q or p != q[-1]:
            q.append(p)
    if len(q) > 1 and q[0] == q[-1]:
        q.pop()  # closed implicitly
    if len(q) < 3:
        return None
    out = [q[0][0], q[0][1]]
    for a, b in zip(q, q[1:]):
        out += [b[0] - a[0], b[1] - a[1]]
    return out


def rings_of(geometry):
    """(ring, is_hole) for every ring of a Polygon or MultiPolygon: a polygon's
    first ring is its outline, the others are holes in it."""
    polys = (
        [geometry["coordinates"]]
        if geometry["type"] == "Polygon"
        else geometry["coordinates"]
    )
    for poly in polys:
        for i, ring in enumerate(poly):
            yield ring, i > 0


def keeps_ring(span, is_hole, largest):
    """Whether a ring of box ``span`` stays in a region's outline."""
    if largest:
        return True
    return span >= (UNIT if is_hole else MIN_RING_SPAN)


def build(features):
    countries, index, regions = [], {}, []
    for f in features:
        p = f["properties"]
        iso = p.get("iso_a2") or ""
        if iso in ("-1", "-99", ""):
            iso = (p.get("iso_3166_2") or "")[:2]
            if not (len(iso) == 2 and iso.isalpha()):
                iso = ""  # a sentinel ("-99") is no code
        admin = COUNTRY_NAMES.get(p["admin"], p["admin"])
        key = (admin, iso)
        if key not in index:
            index[key] = len(countries)
            countries.append([admin, iso])
        rings = []
        candidates = []
        for ring, is_hole in rings_of(f["geometry"]):
            xs = [c[0] for c in ring]
            ys = [c[1] for c in ring]
            span = max(max(xs) - min(xs), max(ys) - min(ys))
            candidates.append((span, ring, is_hole))
        candidates.sort(key=lambda c: -c[0])
        for i, (span, ring, is_hole) in enumerate(candidates):
            if not keeps_ring(span, is_hole, i == 0):
                continue
            # A small hole is kept as it is: simplifying to 3 km would take it away.
            enc = encode_ring(simplify([tuple(c[:2]) for c in ring], TOLERANCE if span >= MIN_RING_SPAN else 0))
            if enc:
                rings.append(enc)
        if not rings:
            # A region smaller than the rounding (Monaco, the Vatican): a
            # small square on its centre, so it is still somewhere.
            box = candidates[0][1]
            cx = sum(c[0] for c in box) / len(box)
            cy = sum(c[1] for c in box) / len(box)
            h = MIN_RING_SPAN / 2
            rings.append(
                encode_ring([(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)])
            )
        name = p.get("name_en") or p.get("name") or ""
        postal = p.get("postal") or ""
        if postal in ("-99", "-1"):
            postal = ""
        regions.append([name, postal, index[key], rings])
    return {"v": 1, "unit": UNIT, "countries": countries, "regions": regions}


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "rb") as f:
            raw = f.read()
    else:
        raw = urllib.request.urlopen(SOURCE, timeout=300).read()
    data = build(json.loads(raw)["features"])
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.GzipFile(OUT, "wb", compresslevel=9, mtime=0) as f:
        f.write(blob)
    points = sum(len(r) // 2 for reg in data["regions"] for r in reg[3])
    print(
        f"{len(data['regions'])} regions, {len(data['countries'])} countries, "
        f"{points} points, {len(blob):,} bytes json, {os.path.getsize(OUT):,} bytes gz"
    )


if __name__ == "__main__":
    main()
