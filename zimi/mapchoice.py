"""Which map a place should open, or be offered, from every view.

The 3D view, its Go to sheet, an article with coordinates and the Almanac's
place all ask the same question of a point: is there an installed map of it,
and if not, which map would be worth downloading? One answer, here, so the four
never disagree. Installed maps come from the library (``map_bounds``, read from
each map's own config); the maps on offer come from the catalogs Zimi already
holds (Kiwix's, StreetZim's), placed by ``mapregions``' table. Nothing is
fetched: a catalog Zimi cannot read is no offers.

The rule, for installed and offered maps alike: only maps whose ground includes
the point; the smallest region first (the most detail for the point); among
regions of about the same size the newest; then the smallest file. The map of
the whole planet is a last resort, never a first.
"""

import math
import re

from zimi import mapregions

# Regions within this factor of each other in area count as the same size, so a
# newer map of Texas beats an older one drawn a few kilometres wider.
SAME_SIZE_RATIO = 1.3
MAX_OFFERS = 3
MAX_WORLD_OFFERS = 1

_DIGITS = re.compile(r"\d+")


def lng_in(lng, w, e):
    """Whether a longitude lies in [w, e]; a box with w > e crosses the antimeridian."""
    return (w <= lng <= e) if w <= e else (lng >= w or lng <= e)


def covers(box, lat, lng):
    """True/False for a ``[W, S, E, N]`` box; None when the box is unknown."""
    if not box or len(box) != 4:
        return None
    w, s, e, n = box
    return s <= lat <= n and lng_in(lng, w, e)


def area(box):
    """Surface of a box on the sphere, in steradians (rows near the poles are narrow)."""
    w, s, e, n = box
    span = (e - w) if e >= w else (e + 360.0 - w)
    return abs(math.sin(math.radians(n)) - math.sin(math.radians(s))) * math.radians(
        span
    )


def size_tier(box):
    """Boxes of about the same area share a tier."""
    return math.floor(math.log(max(area(box), 1e-9)) / math.log(SAME_SIZE_RATIO))


def date_key(text):
    """``2026-06-08``, ``2026-06`` or a file name carrying one, as a number that sorts by recency; 0 when unknown."""
    digits = _DIGITS.findall(text or "")
    if not digits:
        return 0
    year = int(digits[0])
    month = int(digits[1]) if len(digits) > 1 else 0
    day = int(digits[2]) if len(digits) > 2 else 0
    return year * 10000 + month * 100 + day


def _order(box, date, size):
    return (size_tier(box), -date_key(date), size or 0)


def _source(row):
    if (
        row.get("source") == "streetzim"
        or row.get("map_search")
        or str(row.get("name", "")).startswith("osm-")
    ):
        return "streetzim"
    return "kiwix"


def installed_maps(zims, lat, lng):
    """The installed maps of the point, best first. A map whose ground is unknown cannot be said to hold it."""
    found = []
    for z in zims or ():
        if z.get("kind") != "map" or not z.get("main_path"):
            continue
        box = z.get("map_bounds")
        if covers(box, lat, lng) is not True:
            continue
        date = z.get("date") or z.get("file") or ""
        found.append(
            (
                _order(box, date, z.get("size_bytes")),
                {
                    "name": z["name"],
                    "title": z.get("title") or z["name"],
                    "main_path": z["main_path"],
                    "source": _source(z),
                    "size_bytes": z.get("size_bytes") or 0,
                    "date": date,
                    "bounds": box,
                    "world": mapregions.is_world(box),
                },
            )
        )
    found.sort(key=lambda r: r[0])
    return [r[1] for r in found]


def offered_maps(
    items, installed_names, lat, lng, limit=MAX_OFFERS, world_limit=MAX_WORLD_OFFERS
):
    """The catalog maps worth offering for the point, as ``(here, world)``: here are the regions that
    include it, best first; world are the maps of the whole planet, a last resort."""
    here, world = [], []
    for it in items or ():
        name = it.get("name")
        if not name or name in installed_names or not it.get("download_url"):
            continue
        box = it.get("bounds") or mapregions.bounds_for(name)
        if not box:
            continue
        row = {
            "name": name,
            "title": it.get("title") or name,
            "source": _source(it),
            "size_bytes": it.get("size_bytes") or 0,
            "date": it.get("date") or "",
            "download_url": it["download_url"],
            "bounds": box,
        }
        order = _order(box, row["date"], row["size_bytes"])
        if mapregions.is_world(box):
            world.append((order, row))
        elif covers(box, lat, lng):
            here.append((order, row))
    here.sort(key=lambda r: r[0])
    world.sort(key=lambda r: (r[1]["size_bytes"], r[0]))
    return [r[1] for r in here[:limit]], [r[1] for r in world[:world_limit]]


def catalog_maps():
    """Every map the catalogs Zimi holds list, without touching the network."""
    from zimi import library, streetzim

    items = [
        i
        for i in library.offline_catalog()[0]
        if str(i.get("name", "")).startswith("maps_")
    ]
    items += streetzim.get(allow_refresh=False)[0]
    return items


def answer(zims, lat, lng, catalog=None):
    """The whole answer for a point: ``installed`` (best first); when no regional map is installed,
    ``offers`` (regions to download) and ``world`` (the planet, last resort)."""
    installed = installed_maps(zims, lat, lng)
    out = {"installed": installed, "offers": [], "world": []}
    if any(not m["world"] for m in installed):
        return out
    items = catalog_maps() if catalog is None else catalog
    out["offers"], out["world"] = offered_maps(
        items, {z.get("name") for z in zims or ()}, lat, lng
    )
    if installed:  # the planet is already here: no second planet on offer
        out["world"] = []
    return out
