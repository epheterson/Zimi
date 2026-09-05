#!/usr/bin/env python3
"""Build zimi/static/tz-borders.json — real civil time zone boundaries (v3).

The almanac's Sun & Daylight world map draws the actual, irregular political
time zone boundaries (China's single zone, India's half-hour offset, the
jagged International Date Line) rather than the nominal 15-degree solar
meridians. This script produces the compact asset the map consumes: the
dissolved border polylines it strokes, plus each zone's simplified polygon
tagged with its STANDARD UTC offset, so the client can ray-cast the picked
location into its CONTAINING zone and light up the true shape — offset
matching can never be right year-round because the live offset is DST-shifted
while the geographic zone shape is the standard-time one.

Source & license
----------------
timezone-boundary-builder release 2026c, asset timezones-with-oceans-now
(OSM-derived tz-database zone polygons, whole-globe coverage including ocean
Etc/GMT bands and Antarctica). The exact release URL and its sha256 are
pinned in SOURCE_URL / SOURCE_SHA256 below and verified on every download,
so the asset is rebuildable bit-for-bit from the same input.

The data is ODbL 1.0, (c) OpenStreetMap contributors — see
zimi/static/tz-borders-LICENSE.txt, which ships next to the emitted asset.
ODbL covers the DATA only; it does not affect Zimi's MIT code license, but the
attribution notice and the license file must travel with tz-borders.json.

v2 was built from Natural Earth 10m Time Zones (public domain, zero license
text — the reason it was chosen first). It was dropped because the NE layer is
a 2010s political snapshot, still unfixed upstream as of Aug 2026 (verified
point-in-polygon against master): Russia's 2014 permanent-DST reversal,
Istanbul 2016, Caracas 2016, Casablanca 2018, Norfolk Island 2015, Almaty
2024 and Ittoqqortoormiit 2024 are all wrong there — 13 known-stale cities.
timezone-boundary-builder tracks the live tz database, so all 13 resolve
correctly, and it retires two other NE fictions: Antarctica becomes real
station zones (Vostok keeps +5, Palmer -3) instead of nominal hour wedges,
and dead offsets (+11:30 Norfolk, -4:30 Caracas) disappear — 38 standard
offsets, not NE's 40.

Standard-offset rule (the tz-zone -> offset-band dissolve)
----------------------------------------------------------
The map wants one polygon set per STANDARD offset, but the source shapes are
tz-database zones (America/New_York). Each zone's standard offset is taken as

    min(utcoffset on 2026-01-15 12:00 UTC, utcoffset on 2026-07-15 12:00 UTC)

January alone is wrong in the southern hemisphere (January IS summer there),
and dst()==0 is wrong for negative-DST zones (tzdata models Dublin as
standard IST +1 with a winter dst of -1h, which would split Ireland from the
UK's 0 band). min() of the two samples works everywhere because DST always
displaces a clock UP from the offset the zone shares with its non-DST
neighbours — New York -5/-4, Sydney +11/+10, Lord Howe +11/+10:30, Dublin
+1/+0, Troll +2/+0 all pick the right one. The dates are pinned (not "today")
so a rebuild is reproducible and matches the JAN/JUL constants in
tests/test_tz_zone_grouping.cjs; both dodge Ramadan 2026 (Feb 17 - Mar 19),
when Morocco briefly leaves its permanent +1.

Pipeline
--------
1. Download the release zip (cached in the system temp dir), verify sha256,
   read the GeoJSON inside (--src FILE skips the download).
2. Per feature: split any ring that wraps the antimeridian (one polygon in
   2026c does — Pacific/Auckland's Antarctic pole cap), then snap to a 0.01
   degree grid so shared borders stay exactly coincident through the union.
3. Group features by standard offset, unary_union each group. The result is a
   partition of the whole globe into 38 offset regions.
4. Dissolve ALL region boundaries with unary_union (a border between two
   regions is emitted once, not twice), line_merge, Douglas-Peucker simplify
   (SIMPLIFY_DEG, about half a pixel at the target 800 px map width), quantize
   to 0.1 degree. This ONE simplified linework is shared by both outputs:
5.   a. Stroked lines: cut at antimeridian jumps and lat +/-90 frame edges,
        drop sub-pixel pieces.
     b. Zone polygons: polygonize the linework into faces, tag each face with
        the offset region containing its representative point, re-merge faces
        per offset. Because fill edges and stroke edges are the same
        coordinates, zones tile the map with NO slivers between neighbours
        and NO same-offset overlaps — every point resolves, and the client's
        nearest-boundary fallback is for sub-0.1-degree pinholes only.
6. Orient rings (exteriors CCW, holes CW — the client fills NONZERO, so holes
   must wind against their outer ring to cut), sort entries by ascending area
   (first-containing-entry resolution then favours an island over any
   accidental cover by a larger neighbour), and bridge the one legal
   360-degree seam (the +12 Antarctic cap closes along the lat -90 map edge)
   with intermediate vertices so no emitted segment spans > 180 degrees.
7. Emit compact JSON:
   {"v": 3, "source": ...,
    "lines": [[lon,lat,...], ...],           # flat stroked polylines
    "zones": [[offsetMinutes, [[lon,lat,...], ...]], ...]}
   Each zone entry is one polygon part: its UTC offset in minutes (int;
   +330 = India) plus flat unclosed rings, exterior first, then holes —
   unclosed because the client's even-odd ray cast and Path2D closePath both
   supply the closing edge.

Usage
-----
    .venv/bin/python scripts/build-tz-borders.py [--src FILE] [--out FILE]

Requires: shapely >= 2.0 (pip install shapely), and a host tzdata current
enough to know Kazakhstan's 2024 unification (guarded below).
"""

import argparse
import gzip
import hashlib
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from shapely import line_merge, set_precision, unary_union
from shapely.affinity import translate
from shapely.geometry import (
    LineString,
    MultiLineString,
    MultiPolygon,
    Polygon,
    box,
    shape,
)
from shapely.geometry.polygon import orient
from shapely.ops import polygonize
from shapely.prepared import prep

SOURCE_RELEASE = "2026c"
SOURCE_URL = (
    "https://github.com/evansiroky/timezone-boundary-builder/releases/download/"
    "2026c/timezones-with-oceans-now.geojson.zip"
)
SOURCE_SHA256 = "815f5be7f01bd7c4110a1706d9afa4f8d751a6db4fe46c4d5d163941e2c38147"
SOURCE_INNER = "combined-with-oceans-now.json"

DEFAULT_OUT = os.path.join(
    os.path.dirname(__file__), "..", "zimi", "static", "tz-borders.json"
)

SIMPLIFY_DEG = 0.25  # DP tolerance; ~0.5 px on an 800 px-wide map
QUANT = 1  # decimal places kept (0.1 deg ~ 11 km at the equator)
SNAP_DEG = 0.01  # pre-union grid; keeps the partition's shared borders shared
MIN_BBOX_DEG = 0.5  # drop stroked polylines smaller than ~1 px at target size
POLE_LAT = 89.95  # segments with both ends beyond this are frame edges
MAX_BYTES = 250 * 1024  # hard size budget for the emitted asset (v3 ~121 KB)

# The two sample instants of the standard-offset rule (see module docstring).
# Pinned to match JAN/JUL in tests/test_tz_zone_grouping.cjs.
STD_JAN = datetime(2026, 1, 15, 12, tzinfo=timezone.utc)
STD_JUL = datetime(2026, 7, 15, 12, tzinfo=timezone.utc)

# Post-2024 facts the host tzdata must know, or every derived offset is suspect.
TZDATA_SENTINELS = [("Asia/Almaty", 300), ("Pacific/Norfolk", 660)]


def std_offset_min(tzid):
    """A zone's standard UTC offset in minutes (rule in module docstring)."""
    z = ZoneInfo(tzid)
    jan = STD_JAN.astimezone(z).utcoffset()
    jul = STD_JUL.astimezone(z).utcoffset()
    return int(min(jan, jul).total_seconds() // 60)


def fetch_source(src_path):
    if src_path:
        with open(src_path) as f:
            return json.load(f)
    cache = os.path.join(tempfile.gettempdir(), os.path.basename(SOURCE_URL))
    if not os.path.exists(cache):
        print("downloading %s ..." % SOURCE_URL)
        urllib.request.urlretrieve(SOURCE_URL, cache)
    digest = hashlib.sha256(open(cache, "rb").read()).hexdigest()
    if digest != SOURCE_SHA256:
        sys.exit(
            "source zip sha256 mismatch: got %s, pinned %s — delete %s and retry"
            % (digest, SOURCE_SHA256, cache)
        )
    with zipfile.ZipFile(cache) as zf, zf.open(SOURCE_INNER) as f:
        return json.load(f)


def polys_of(geom):
    """Flatten any geometry to its polygon components."""
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type == "MultiPolygon":
        return list(geom.geoms)
    if geom.geom_type == "GeometryCollection":
        return [p for sub in geom.geoms for p in polys_of(sub)]
    return []


def unwrap_split(geom):
    """Split polygons whose rings jump the antimeridian.

    2026c has exactly one (Pacific/Auckland's Antarctic pole cap closes with a
    lon 180 -> -180 segment along lat -90). Left alone, that ring reads as a
    map-wide planar slash. Unwrap into continuous longitude space, then cut at
    the +/-180 columns and shift the overhang back into range.
    """
    out = []
    for p in polys_of(geom):
        wraps = False
        rings = []
        for ring in [p.exterior] + list(p.interiors):
            pts = list(ring.coords)
            fixed = [pts[0]]
            for x, y in pts[1:]:
                px = fixed[-1][0]
                while x - px > 180:
                    x -= 360
                    wraps = True
                while x - px < -180:
                    x += 360
                    wraps = True
                fixed.append((x, y))
            rings.append(fixed)
        if not wraps:
            out.append(p)
            continue
        q = Polygon(rings[0], rings[1:])
        for part in (
            q.intersection(box(-180, -90, 180, 90)),
            translate(q.intersection(box(180, -90, 540, 90)), xoff=-360),
            translate(q.intersection(box(-540, -90, -180, 90)), xoff=360),
        ):
            out.extend(polys_of(part))
    return MultiPolygon(out)


def quantize(coords):
    """Round to QUANT decimals, dropping consecutive duplicates."""
    out = []
    for x, y in coords:
        pt = (round(x, QUANT), round(y, QUANT))
        if not out or pt != out[-1]:
            out.append(pt)
    return out


def cut_polyline(pts):
    """Split at antimeridian jumps and drop segments hugging the lat +/-90 frame.

    Returns a list of polylines (each a list of (lon, lat)) in which every
    consecutive pair spans < 180 deg of longitude and at least one endpoint of
    every segment is off the polar frame edge.
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


def bridge_pole_seam(pts):
    """Insert vertices so no ring segment spans > 180 deg of longitude.

    The only legal wide segment runs along a polar map edge (the +12 zone's
    Antarctic cap closes from (-180,-90) to (180,-90)); it is bridged with
    same-latitude waypoints, which changes nothing visually or for the ray
    cast. A wide segment anywhere else means broken geometry: abort.
    """
    out = []
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]  # every segment, closing seam included
        out.append(a)
        if abs(b[0] - a[0]) > 180:
            if not (abs(a[1]) >= POLE_LAT and abs(b[1]) >= POLE_LAT):
                sys.exit(
                    "ring segment spans >180 deg off the polar edge: %s -> %s" % (a, b)
                )
            steps = int(abs(b[0] - a[0]) // 120)
            for s in range(1, steps + 1):
                out.append((round(a[0] + (b[0] - a[0]) * s / (steps + 1), QUANT), a[1]))
    return out


def build_offset_unions(geojson):
    """The globe partitioned into one (Multi)Polygon per standard offset."""
    groups = {}
    for feat in geojson["features"]:
        off = std_offset_min(feat["properties"]["tzid"])
        geom = set_precision(unwrap_split(shape(feat["geometry"])), SNAP_DEG)
        groups.setdefault(off, []).append(geom)
    return {off: unary_union(gs) for off, gs in groups.items()}


def build_linework(unions):
    """One simplified, quantized polyline set for ALL zone borders.

    unary_union nodes and dissolves shared edges (each border emitted once);
    line_merge re-joins the noded fragments; simplify/quantize happen HERE,
    once, so the stroked lines and the polygonized zone fills use identical
    coordinates — that identity is what guarantees a sliver-free tiling.
    """
    blines = []
    for u in unions.values():
        b = u.boundary
        blines.extend(b.geoms if not isinstance(b, LineString) else [b])
    merged = line_merge(unary_union(blines))
    if isinstance(merged, LineString):
        merged = MultiLineString([merged])
    linework = []
    for line in merged.geoms:
        pts = quantize(line.simplify(SIMPLIFY_DEG).coords)
        if len(pts) >= 2:
            linework.append(pts)
    return linework


def build_zones(unions, linework):
    """Zone entries [[offsetMinutes, [flat rings]], ...] from the shared linework.

    polygonize tiles the world rectangle into faces bounded by the linework;
    each face takes the offset of the exact (pre-simplification) region that
    contains its representative point; faces re-merge per offset so a border
    between same-offset faces disappears. Every face is kept — tiny island
    zones (Lord Howe, Midway) are sub-pixel on screen but must exist for a
    tapped city dot to resolve to its true offset.
    """
    noded = unary_union([LineString(l) for l in linework])
    faces = list(polygonize(noded.geoms if hasattr(noded, "geoms") else [noded]))
    prepared = {off: prep(u) for off, u in unions.items()}
    face_groups = {}
    for face in faces:
        rp = face.representative_point()
        for off, pu in prepared.items():
            if pu.contains(rp):
                face_groups.setdefault(off, []).append(face)
                break
        else:
            # A hairline face opened by quantization, its probe point on a
            # boundary: give it to the nearest region rather than leave a hole.
            off = min(unions, key=lambda o: unions[o].distance(rp))
            face_groups.setdefault(off, []).append(face)

    entries = []
    for off, fs in face_groups.items():
        for poly in polys_of(unary_union(fs)):
            poly = orient(poly)  # exteriors CCW, holes CW: nonzero fill cuts holes
            rings = []
            for ring in [poly.exterior] + list(poly.interiors):
                pts = quantize(ring.coords)
                if len(pts) > 1 and pts[0] == pts[-1]:
                    pts.pop()
                if len(pts) < 3:
                    continue
                pts = bridge_pole_seam(pts)
                rings.append([c for p in pts for c in p])
            if rings:
                entries.append((abs(poly.area), off, rings))
    # Ascending area: the shipped resolver takes the FIRST containing entry,
    # so an island zone must be scanned before any larger region whose dropped
    # sub-pixel hole would otherwise swallow the pick.
    entries.sort(key=lambda e: e[0])
    return [[off, rings] for _, off, rings in entries]


def build_lines(linework):
    """Stroked polylines: the same linework, frame-cut and sub-pixel-filtered."""
    out_lines = []
    for pts in linework:
        for piece in cut_polyline(pts):
            if bbox_visible(piece):
                out_lines.append([c for p in piece for c in p])
    return out_lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", help="local combined-with-oceans-now.json (skip download)")
    ap.add_argument("--out", default=os.path.normpath(DEFAULT_OUT))
    args = ap.parse_args()

    for tzid, want in TZDATA_SENTINELS:
        got = std_offset_min(tzid)
        if got != want:
            sys.exit(
                "host tzdata is stale: %s standard offset %d, expected %d — "
                "update the OS tz database (or pip install tzdata) and rebuild"
                % (tzid, got, want)
            )

    geojson = fetch_source(args.src)
    unions = build_offset_unions(geojson)
    print("offset regions: %d" % len(unions))

    linework = build_linework(unions)
    print(
        "linework: %d polylines (%d pts)"
        % (len(linework), sum(len(l) for l in linework))
    )

    zones = build_zones(unions, linework)
    out_lines = build_lines(linework)

    npts = sum(len(l) for l in out_lines) // 2
    zpts = sum(len(r) for _, rings in zones for r in rings) // 2
    doc = {
        "v": 3,
        "source": "timezone-boundary-builder %s (ODbL, (c) OpenStreetMap contributors"
        " — see tz-borders-LICENSE.txt)" % SOURCE_RELEASE,
        "lines": out_lines,
        "zones": zones,
    }
    blob = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    gz = len(gzip.compress(blob, 9))
    print(
        "emit: %d polylines (%d pts), %d zone entries over %d offsets (%d pts), "
        "%d bytes raw, %d bytes gzip"
        % (
            len(out_lines),
            npts,
            len(zones),
            len({z[0] for z in zones}),
            zpts,
            len(blob),
            gz,
        )
    )
    if len(blob) > MAX_BYTES:
        sys.exit("asset exceeds %d byte budget" % MAX_BYTES)

    with open(args.out, "wb") as f:
        f.write(blob)
    print("wrote %s" % args.out)


if __name__ == "__main__":
    main()
