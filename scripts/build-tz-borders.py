#!/usr/bin/env python3
"""Build zimi/static/tz-borders.json — real civil time zone boundaries.

The almanac's Sun & Daylight world map draws the actual, irregular political
time zone boundaries (China's single zone, India's half-hour offset, the
jagged International Date Line) rather than the nominal 15-degree solar
meridians. This script produces the compact polyline asset the map strokes.

Source & license
----------------
Natural Earth 10m "Time Zones" (ne_10m_time_zones.geojson, 120 polygons,
~3.5 MB), fetched from the naturalearth/natural-earth-vector repository.
Natural Earth is PUBLIC DOMAIN — no attribution required, though the asset
header credits it anyway. Chosen over timezone-boundary-builder (OSM-derived)
because: (a) public domain vs ODbL share-alike, so no license text must ship
in the UI; (b) ~3.5 MB source vs ~45 MB+; (c) at the target resolution
(a ~800 px-wide world map, ~0.45 deg/px) the two are indistinguishable — the
characteristic shapes (one zone across all of China, India/Nepal fractional
offsets, Australia's three-way split, US state-line steps) all survive.
Boundaries at sea are the straight nominal meridians by definition (nautical
time); on land they follow the political borders. NE's zone polygons predate
a few recent national changes, which at half-degree resolution is invisible.

Pipeline
--------
1. Download the GeoJSON (cached in the system temp dir; --src to use a file).
2. Extract every polygon's boundary rings as linework and unary_union them —
   the union nodes and dissolves shared edges, so a border between two
   adjacent zones is emitted once, not twice. line_merge then re-joins the
   noded fragments into long polylines.
3. Douglas-Peucker simplify (SIMPLIFY_DEG tolerance, about half a pixel at
   the target map width).
4. Quantize to 1 decimal place, drop consecutive duplicates, drop polylines
   whose bounding box is sub-pixel at target size, cut segments that run
   along the lat ±90 frame edge (map border noise, not zone borders).
5. Split any polyline at antimeridian jumps (no emitted segment spans more
   than 180 degrees of longitude, so the renderer never draws a wrap streak).
6. Emit compact JSON: {"v": 1, "source": ..., "lines": [[lon,lat,...], ...]}
   with each line a flat [lon, lat, lon, lat, ...] array.

Usage
-----
    .venv/bin/python scripts/build-tz-borders.py [--src FILE] [--out FILE]

Requires: shapely (pip install shapely).
"""

import argparse
import gzip
import json
import os
import sys
import tempfile
import urllib.request

from shapely import line_merge, unary_union
from shapely.geometry import LineString, MultiLineString, shape

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_10m_time_zones.geojson"
)
DEFAULT_OUT = os.path.join(
    os.path.dirname(__file__), "..", "zimi", "static", "tz-borders.json"
)

SIMPLIFY_DEG = 0.25  # DP tolerance; ~0.5 px on an 800 px-wide map
QUANT = 1  # decimal places kept (0.1 deg ~ 11 km at the equator)
MIN_BBOX_DEG = 0.5  # drop polylines smaller than ~1 px at target size
POLE_LAT = 89.95  # segments with both ends beyond this are frame edges
MAX_BYTES = 400 * 1024  # hard size budget for the emitted asset


def fetch_source(src_path):
    if src_path:
        with open(src_path) as f:
            return json.load(f)
    cache = os.path.join(tempfile.gettempdir(), "ne_10m_time_zones.geojson")
    if not os.path.exists(cache):
        print("downloading %s ..." % SOURCE_URL)
        urllib.request.urlretrieve(SOURCE_URL, cache)
    with open(cache) as f:
        return json.load(f)


def dissolve_borders(geojson):
    """All polygon boundaries, shared edges drawn once."""
    lines = []
    for feat in geojson["features"]:
        geom = shape(feat["geometry"])
        b = geom.boundary
        if isinstance(b, LineString):
            lines.append(b)
        else:
            lines.extend(b.geoms)
    merged = line_merge(unary_union(lines))
    if isinstance(merged, LineString):
        merged = MultiLineString([merged])
    return list(merged.geoms)


def quantize(line):
    """Round to QUANT decimals, dropping consecutive duplicates."""
    out = []
    for x, y in line.coords:
        pt = (round(x, QUANT), round(y, QUANT))
        if not out or pt != out[-1]:
            out.append(pt)
    return out


def cut_polyline(pts):
    """Split at antimeridian jumps and drop segments hugging the lat ±90 frame.

    Returns a list of polylines (each a list of (lon, lat)) in which every
    consecutive pair spans < 180 deg of longitude and at least one endpoint of
    every segment is south of the polar frame edge.
    """
    pieces, cur = [], [pts[0]]
    for a, b in zip(pts, pts[1:]):
        frame_edge = abs(a[1]) >= POLE_LAT and abs(b[1]) >= POLE_LAT
        wraps = abs(b[0] - a[0]) > 180
        if frame_edge or wraps:
            if len(cur) >= 2:
                pieces.append(cur)
            cur = [b]
        else:
            cur.append(b)
    if len(cur) >= 2:
        pieces.append(cur)
    return pieces


def bbox_visible(pts):
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return (max(lons) - min(lons)) + (max(lats) - min(lats)) >= MIN_BBOX_DEG


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", help="local ne_10m_time_zones.geojson (skip download)")
    ap.add_argument("--out", default=os.path.normpath(DEFAULT_OUT))
    args = ap.parse_args()

    geojson = fetch_source(args.src)
    borders = dissolve_borders(geojson)
    print("dissolved: %d polylines" % len(borders))

    out_lines = []
    for line in borders:
        pts = quantize(line.simplify(SIMPLIFY_DEG))
        if len(pts) < 2:
            continue
        for piece in cut_polyline(pts):
            if bbox_visible(piece):
                flat = []
                for lon, lat in piece:
                    flat.append(lon)
                    flat.append(lat)
                out_lines.append(flat)

    npts = sum(len(l) for l in out_lines) // 2
    doc = {
        "v": 1,
        "source": "Natural Earth 10m Time Zones (public domain, naturalearthdata.com)",
        "lines": out_lines,
    }
    blob = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    gz = len(gzip.compress(blob, 9))
    print(
        "emit: %d polylines, %d points, %d bytes raw, %d bytes gzip"
        % (len(out_lines), npts, len(blob), gz)
    )
    if len(blob) > MAX_BYTES:
        sys.exit("asset exceeds %d byte budget" % MAX_BYTES)

    with open(args.out, "wb") as f:
        f.write(blob)
    print("wrote %s" % args.out)


if __name__ == "__main__":
    main()
