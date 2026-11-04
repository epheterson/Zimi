"""Towns on a Kiwix map, findable by name.

Kiwix's maps2zim writes a ``search/<Place>`` page for the places its
GeoNames list holds, and the world map's list stops well short of every
town: Danville, California (43,000 people) is on the map, labelled, and in
no page (Eric, 2026-11-02: "I see my Danville in CA on the map but it
doesn't show up in search"). The names are in the map itself, in the
``place`` layer of its vector tiles, so they are read from there: once per
build of the ZIM, in the background (a child process for a big map), into
``<data dir>/mapplaces/<name>.db``, one row per word of each name so a
search asks an index and never a tile.

Two zooms are read. Zoom 9 carries the cities; zoom 10 is where towns are
labelled (Danville first appears there). Villages start at 11, four times
the tiles again, and are left out. Zoom 10 is read only under a zoom 9 tile
with land in it: the sea's tiles are a few hundred bytes, and skipping them
leaves about 200,000 of the world map's tiles to read, some 20 minutes on a
NAS, once.

The tile format is Mapbox Vector Tile (protobuf), read here by hand for the
one layer wanted: no dependency for 60 lines.
"""

import gzip
import logging
import math
import os
import sqlite3
import threading

from zimi import mapsearch
from zimi import server as _srv
from zimi.details import DetailsBuilder

log = logging.getLogger("zimi")

CITY_ZOOM = 9
TOWN_ZOOM = 10
# A zoom 9 tile smaller than this is sea (a water polygon and little else);
# measured on maps_en_all_2026-06: 218,277 tiles, 50,811 above it.
LAND_TILE_MIN_BYTES = 2048
CLASSES = ("city", "town")
ZOOM_FOR_CLASS = {"city": 12, "town": 13}
# The rows a query's first word may draw from before they are scored.
CANDIDATES_MAX = 400
_DEFAULT_EXTENT = 4096
_MVT_POINT = 1
_MVT_MOVE_TO = 1


# ── Mapbox Vector Tile, the place layer only ──────────────────────────────


def _varint(buf, i):
    out = shift = 0
    while True:
        b = buf[i]
        i += 1
        out |= (b & 0x7F) << shift
        shift += 7
        if b < 0x80:
            return out, i


def _fields(buf):
    """(field number, value) of each protobuf field; a length-delimited
    value as a memoryview, a varint as an int, fixed ones as None."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 2:
            size, i = _varint(buf, i)
            value = buf[i : i + size]
            i += size
        elif wire == 1:
            value, i = None, i + 8
        elif wire == 5:
            value, i = None, i + 4
        else:
            raise ValueError(f"protobuf wire type {wire}")
        yield field, value


def _packed(buf):
    i, out = 0, []
    while i < len(buf):
        v, i = _varint(buf, i)
        out.append(v)
    return out


def _unzigzag(n):
    return (n >> 1) ^ -(n & 1)


def tile_places(data, z, x, y):
    """Each labelled point in a tile's ``place`` layer: (tags, lat, lng)."""
    buf = memoryview(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
    for field, layer in _fields(buf):
        if field != 3:
            continue
        name, keys, values, features, extent = None, [], [], [], _DEFAULT_EXTENT
        for f, v in _fields(layer):
            if f == 1:
                name = bytes(v).decode("utf-8", "replace")
                if name != "place":
                    break
            elif f == 3:
                keys.append(bytes(v).decode("utf-8", "replace"))
            elif f == 4:
                value = None
                for vf, vv in _fields(v):
                    if vf == 1:
                        value = bytes(vv).decode("utf-8", "replace")
                values.append(value)
            elif f == 2:
                features.append(v)
            elif f == 5:
                extent = v
        if name != "place":
            continue
        for feature in features:
            tags, kind, geom = {}, None, None
            for f, v in _fields(feature):
                if f == 2:
                    pairs = _packed(v)
                    for k in range(0, len(pairs) - 1, 2):
                        if pairs[k] < len(keys) and pairs[k + 1] < len(values):
                            tags[keys[pairs[k]]] = values[pairs[k + 1]]
                elif f == 3:
                    kind = v
                elif f == 4:
                    geom = _packed(v)
            if kind != _MVT_POINT or not geom or len(geom) < 3:
                continue
            if geom[0] & 0x7 != _MVT_MOVE_TO:
                continue
            px, py = _unzigzag(geom[1]), _unzigzag(geom[2])
            lat, lng = tile_point(z, x, y, px / extent, py / extent)
            yield tags, lat, lng


def tile_point(z, x, y, fx, fy):
    """Latitude and longitude of a point ``fx``, ``fy`` (0..1) across tile
    ``z/x/y`` in Web Mercator."""
    n = 2**z
    lng = (x + fx) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + fy) / n))))
    return lat, lng


# ── the build ─────────────────────────────────────────────────────────────


def _tile(archive, z, x, y):
    path = f"tiles/{z}/{x}/{y}.pbf"
    if not archive.has_entry_by_path(path):
        return None
    return bytes(archive.get_entry_by_path(path).get_item().content)


def _display_name(tags):
    return tags.get("name:en") or tags.get("name_en") or tags.get("name") or ""


def _tile_range(archive, z):
    """The columns and rows of zoom ``z`` the map covers: its bounding box
    (maps2zim's content/config.json, as server._map_bounds reads it), or
    the whole world. Andorra's map asks for 4 tiles, not 262,144."""
    side = 2**z
    box = _srv._map_bounds(archive)
    if not box or box[0] > box[2]:  # none, or across the antimeridian
        return range(side), range(side)
    w, s, e, n = box
    x0, y1, _fx, _fy = _xy(z, s, w)
    x1, y0, _fx, _fy = _xy(z, n, e)
    clamp = lambda v: min(max(v, 0), side - 1)  # noqa: E731
    return range(clamp(x0), clamp(x1) + 1), range(clamp(y0), clamp(y1) + 1)


def _xy(z, lat, lng):
    n = 2**z
    lat = max(min(lat, 85.0511), -85.0511)
    fx = (lng + 180.0) / 360.0 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(fx), int(fy), fx - int(fx), fy - int(fy)


def read_places(archive):
    """Every city (zoom 9) and town (zoom 10) the map labels, once each:
    {(name, class): (lat, lng)} keyed so one place cut by tile edges counts
    once."""
    found = {}

    def take(data, z, x, y):
        for tags, lat, lng in tile_places(data, z, x, y):
            cls = tags.get("class")
            name = _display_name(tags)
            if cls in CLASSES and name:
                found.setdefault((name, cls, round(lat, 2), round(lng, 2)), (lat, lng))

    xs, ys = _tile_range(archive, CITY_ZOOM)
    for x in xs:
        for y in ys:
            data = _tile(archive, CITY_ZOOM, x, y)
            if data is None:
                continue
            take(data, CITY_ZOOM, x, y)
            if len(data) < LAND_TILE_MIN_BYTES:
                continue
            for cx in (2 * x, 2 * x + 1):
                for cy in (2 * y, 2 * y + 1):
                    child = _tile(archive, TOWN_ZOOM, cx, cy)
                    if child is not None:
                        take(child, TOWN_ZOOM, cx, cy)
    return found


def _rows(found):
    """One row per word of each name: (word, name, class, lat, lng)."""
    rows, seen = [], set()
    for (name, cls, _la, _lo), (lat, lng) in found.items():
        for word in set(mapsearch.normalize_text(name).split()):
            key = (word, name, cls, round(lat, 3), round(lng, 3))
            if key in seen:
                continue
            seen.add(key)
            rows.append((word, name, cls, round(lat, 5), round(lng, 5)))
    return rows


def build_places(zim_name, zim_path):
    """Read a map's towns into its file. Opens an archive of its own; runs
    in a child process for a big map."""
    archive = _srv.open_archive(zim_path)
    return _builder.write(zim_name, zim_path, archive, _rows(read_places(archive)))


def _ours(z):
    """A Kiwix map: a map with tiles and no place index of its own."""
    return z.get("kind") == "map" and not z.get("map_search")


_lock = threading.Lock()
_builder = DetailsBuilder(
    "mapplaces",
    zims=_ours,
    label="Maps",
    what="town names",
    version="1",
    table="places",
    columns=("word TEXT", "name TEXT", "class TEXT", "lat REAL", "lng REAL"),
    # Looked up when it runs, as the child process looks it up.
    build=lambda name, path: build_places(name, path),
    load=None,
    lock=_lock,
    on_keep=lambda name, key, details: None,
    indexes=("word",),
)
build_all = _builder.build_all


# ── the search ────────────────────────────────────────────────────────────


def ready(name):
    """Whether ``name``'s towns are read from the ZIM installed now. Asks for
    the read when they are not, so the first search on a new map starts it."""
    path = _srv.get_zim_files().get(name)
    if not path:
        return False
    if _builder.kept(name, path):
        return True
    _builder.request(name)
    return False


def search(name, query, limit=mapsearch.MAX_RESULTS):
    """Places on map ``name`` matching ``query``, best first, in the shape
    mapsearch.search_places answers in. [] until the map has been read."""
    words = mapsearch.normalize_text(query).split()
    if not words or not ready(name):
        return []
    first = max(words, key=len)
    try:
        conn = sqlite3.connect(_builder.path(name), timeout=5)
        try:
            rows = conn.execute(
                "SELECT DISTINCT name, class, lat, lng FROM places"
                " WHERE word >= ? AND word < ? LIMIT ?",
                (first, first + "￿", CANDIDATES_MAX),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as e:
        log.debug("map places %s: %s", name, e)
        return []
    query_norm = " ".join(words)
    scored = []
    for place, cls, lat, lng in rows:
        entry = {"n": place, "t": "place", "s": cls, "a": lat, "o": lng}
        s = mapsearch.score(entry, query_norm, words)
        if s is not None:
            scored.append((s, entry))
    scored.sort(key=lambda p: -p[0])
    out = []
    for s, entry in scored[:limit]:
        place = mapsearch._place_dict(entry)
        place["zoom"] = ZOOM_FOR_CLASS.get(entry["s"], place["zoom"])
        place["score"] = s
        out.append(place)
    return out


def _reset_for_tests():
    _builder.forget()
