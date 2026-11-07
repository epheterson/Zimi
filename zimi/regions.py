"""Which region and country a point is in, offline.

A Kiwix map's tiles name a town and say nothing of where it is, so
"Springfield" is one of dozens. ``zimi/assets/admin1-snapshot.json.gz`` (built
by scripts/build_admin1.py from Natural Earth, public domain; 425 KB) holds
every first-level region of every country as a coarse outline, and ``locate``
answers the region and country a latitude and longitude fall in.

Loaded the first time a map's towns are read (a child process, at the lowest
priority) and never by a search or a page: the answer is written into the
towns' index beside the map, so nothing at search time comes here, except
``country_names`` for the words people type for a country ("USA").
"""

import gzip
import json
import math
import os
import threading
from array import array

ASSET_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "admin1-snapshot.json.gz"
)
# The grid's cell, degrees: a region is listed in every cell its box touches.
CELL = 2.0
# A point in no outline (a coast the outlines cut short, a sea town) takes the
# nearest region within this many degrees (about 55 km).
NEAREST_MAX_DEGREES = 0.5

# What people type for a country besides its name, by ISO 3166 alpha-2.
COUNTRY_ALIASES = {
    "US": ("usa", "u.s.", "u.s.a.", "america", "united states of america"),
    "GB": ("uk", "u.k.", "great britain", "britain", "united kingdom"),
    "AE": ("uae", "emirates"),
    "CZ": ("czech republic",),
    "CI": ("ivory coast",),
    "NL": ("holland", "the netherlands"),
    "KR": ("korea", "republic of korea"),
    "KP": ("korea",),
    "CD": ("congo", "democratic republic of the congo", "drc"),
    "MK": ("macedonia",),
    "SZ": ("swaziland",),
    "TL": ("east timor",),
    "CV": ("cape verde",),
    "RU": ("russian federation",),
    "RS": ("republic of serbia",),
    "TZ": ("united republic of tanzania",),
    "BS": ("the bahamas",),
    "DE": ("deutschland",),
    "ES": ("espana",),
    "AT": ("osterreich",),
    "CH": ("schweiz", "suisse", "svizzera"),
    "JP": ("nippon",),
}

_lock = threading.Lock()
_data = None


class _Region:
    __slots__ = ("name", "postal", "country", "iso", "box", "rings")

    def __init__(self, name, postal, country, iso, rings):
        self.name, self.postal, self.country, self.iso = name, postal, country, iso
        self.rings = rings
        xs = [x for r in rings for x in r[0::2]]
        ys = [y for r in rings for y in r[1::2]]
        self.box = (min(xs), min(ys), max(xs), max(ys))


def _decode(ring, unit):
    """A ring's delta list as two interleaved arrays of degrees, x then y."""
    out = array("d")
    x, y = ring[0], ring[1]
    out.extend((x * unit, y * unit))
    for i in range(2, len(ring), 2):
        x += ring[i]
        y += ring[i + 1]
        out.extend((x * unit, y * unit))
    return out


def _load():
    global _data
    with _lock:
        if _data is not None:
            return _data
        with gzip.open(ASSET_PATH, "rt", encoding="utf-8") as f:
            raw = json.load(f)
        unit = raw["unit"]
        countries = raw["countries"]
        regions, grid = [], {}
        for name, postal, ci, rings in raw["regions"]:
            country, iso = countries[ci]
            region = _Region(
                name, postal, country, iso, [_decode(r, unit) for r in rings]
            )
            at = len(regions)
            regions.append(region)
            x0, y0, x1, y1 = region.box
            for cx in range(math.floor(x0 / CELL), math.floor(x1 / CELL) + 1):
                for cy in range(math.floor(y0 / CELL), math.floor(y1 / CELL) + 1):
                    grid.setdefault((cx, cy), []).append(at)
        _data = (regions, grid, countries)
        return _data


def _inside(rings, x, y):
    """Even-odd: a point is in a region when it is in an odd number of its
    rings, so a hole is no special case."""
    hit = False
    for ring in rings:
        n = len(ring) // 2
        px, py = ring[2 * n - 2], ring[2 * n - 1]
        for i in range(n):
            cx, cy = ring[2 * i], ring[2 * i + 1]
            if (cy > y) != (py > y) and x < (px - cx) * (y - cy) / (py - cy) + cx:
                hit = not hit
            px, py = cx, cy
    return hit


def _distance(rings, x, y, cos):
    """Degrees (east-west scaled by ``cos``) from a point to the nearest edge."""
    best = math.inf
    for ring in rings:
        n = len(ring) // 2
        ax, ay = ring[2 * n - 2], ring[2 * n - 1]
        for i in range(n):
            bx, by = ring[2 * i], ring[2 * i + 1]
            dx, dy = (bx - ax) * cos, by - ay
            px, py = (x - ax) * cos, y - ay
            span = dx * dx + dy * dy
            t = 0.0 if span == 0 else max(0.0, min(1.0, (px * dx + py * dy) / span))
            d = math.hypot(px - t * dx, py - t * dy)
            if d < best:
                best = d
            ax, ay = bx, by
    return best


def locate(lat, lng):
    """``{"region", "postal", "country", "iso"}`` for a point, or None when it
    is further than NEAREST_MAX_DEGREES from every region."""
    regions, grid, _countries = _load()
    cx, cy = math.floor(lng / CELL), math.floor(lat / CELL)
    ids = grid.get((cx, cy), ())
    hits = [
        r
        for r in (regions[i] for i in ids)
        if r.box[0] <= lng <= r.box[2]
        and r.box[1] <= lat <= r.box[3]
        and _inside(r.rings, lng, lat)
    ]
    if hits:
        # Outlines overlap a little where simplified: the smaller box wins.
        found = min(hits, key=lambda r: (r.box[2] - r.box[0]) * (r.box[3] - r.box[1]))
    else:
        cos = max(math.cos(math.radians(lat)), 0.05)
        near = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                near.update(grid.get((cx + dx, cy + dy), ()))
        found, best = None, NEAREST_MAX_DEGREES
        for i in near:
            r = regions[i]
            if (
                lng < r.box[0] - NEAREST_MAX_DEGREES / cos
                or lng > r.box[2] + NEAREST_MAX_DEGREES / cos
                or lat < r.box[1] - NEAREST_MAX_DEGREES
                or lat > r.box[3] + NEAREST_MAX_DEGREES
            ):
                continue
            d = _distance(r.rings, lng, lat, cos)
            if d < best:
                found, best = r, d
        if found is None:
            return None
    return {
        "region": found.name,
        "postal": found.postal,
        "country": found.country,
        "iso": found.iso,
    }


def country_words(country, iso):
    """Every way to write a country that the qualifier of a place accepts:
    its name, its ISO code and the aliases above."""
    return (country, iso) + COUNTRY_ALIASES.get(iso, ())
