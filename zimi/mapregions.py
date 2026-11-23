"""What ground each catalog map covers, from the shipped table.

The catalog knows a map by name and size; where it is lives inside the ZIM,
unreadable until downloaded. ``zimi/assets/map-regions.json`` (built by
``scripts/build_map_regions.py``) holds an approximate ``[W, S, E, N]`` per
catalog map so the map switcher can offer the maps that cover the spot on
screen. A box with W > E crosses the antimeridian. ``world`` marks a map of
everywhere, offered under its own heading rather than as "a map of here".
"""

import json
import os
import threading

ASSET_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "map-regions.json")

# A box this wide and this tall is the planet, not a region.
_WORLD_LNG_SPAN = 300.0
_WORLD_LAT_SPAN = 120.0

_lock = threading.Lock()
_table = None


def _load():
    global _table
    with _lock:
        if _table is not None:
            return _table
        table = {}
        try:
            with open(ASSET_PATH, encoding="utf-8") as f:
                payload = json.load(f)
            for source in ("kiwix", "streetzim"):
                for name, box in (payload.get(source) or {}).items():
                    if isinstance(box, list) and len(box) == 4:
                        table[name] = [float(v) for v in box]
        except (OSError, ValueError, TypeError):
            table = {}
        _table = table
        return table


# Ground inside a map's rectangle that is not the map's: a country's box takes in the sea and the neighbours round it
# (Japan's holds Vladivostok and Seoul, New Zealand's holds Fiji). Offers skip a map for a spot in one of these.
# Boxes are [W, S, E, N], W > E across the antimeridian; deliberately coarse, to stop the wrong country being offered.
NOT_COVERED = {
    "osm-japan": [[122.0, 33.8, 129.2, 46.0], [129.2, 36.0, 138.0, 46.0]],
    "maps_en_new-zealand": [[160.0, -29.0, -160.0, -5.0]],
    "osm-australia-nz": [[154.0, -29.0, 180.0, -9.0]],
    "maps_en_china": [[130.6, 42.0, 135.0, 45.2]],
    "osm-china": [[130.6, 42.0, 135.0, 45.2]],
}


def excludes(name, lat, lng):
    """True when a spot inside the map's rectangle is known not to be the map's ground."""
    for w, s, e, n in NOT_COVERED.get(name, ()):
        if s <= lat <= n and ((w <= lng <= e) if w <= e else (lng >= w or lng <= e)):
            return True
    return False


def bounds_for(name):
    """``[W, S, E, N]`` for a catalog map name, or None."""
    return _load().get(name)


def is_world(box):
    if not box or len(box) != 4:
        return False
    w, s, e, n = box
    lng_span = (e - w) if e >= w else (e + 360.0 - w)
    return lng_span >= _WORLD_LNG_SPAN and (n - s) >= _WORLD_LAT_SPAN


def annotate(items):
    """Add ``bounds`` (and ``world`` when it is the planet) to every catalog
    item the table knows. In place; returns the list for convenience."""
    for it in items or ():
        if not isinstance(it, dict):
            continue
        box = bounds_for(it.get("name"))
        if box is None:
            continue
        it["bounds"] = box
        if is_world(box):
            it["world"] = True
    return items


def _reset_for_tests():
    global _table
    with _lock:
        _table = None
