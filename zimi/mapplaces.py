"""Towns on a Kiwix map, findable by name.

Kiwix's maps2zim writes a ``search/<Place>`` page for the places its
GeoNames list holds, and the world map's list stops well short of every
town: plenty of towns of tens of thousands are on the map, labelled, and in
no page. The names are in the map itself, in the
``place`` layer of its vector tiles, so they are read from there: once per
build of the ZIM, in the background (a child process for a big map), into
``<data dir>/mapplaces/<name>.db``, one row per word of each name so a
search asks an index and never a tile.

Two zooms are read. Zoom 9 carries the cities; zoom 10 is where towns are
labelled (most towns first appear there). Villages start at 11, four times
the tiles again, and are left out. Zoom 10 is read only under a zoom 9 tile
with land in it: the sea's tiles are a few hundred bytes, and skipping them
leaves under 200,000 of the world map's tiles to read: maps_en_all_2026-06
gave 116,003 places in 11 minutes on a NAS at the lowest priority, once.

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
from zimi.placedata import km_between
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
# The tags of a place a row keeps: how big it is, and where it is when the
# tiles say (zimi.regions answers when they do not).
EXTRA_TAGS = (
    "name", "rank", "capital", "state", "is_in:state", "addr:state",
    "country", "is_in:country", "addr:country",
)  # fmt: skip
REGION_TAGS = ("state", "is_in:state", "addr:state")
COUNTRY_TAGS = ("country", "is_in:country", "addr:country")
# Countries whose regions people write as two letters after the town (IL, NSW).
POSTAL_COUNTRIES = ("US", "CA", "AU")
# How big a place is, for ranking: a city over a town, then the tiles' own
# rank (1 is the biggest), then a capital.
CLASS_WEIGHT = {"city": 2000, "town": 1000}
RANK_MAX, RANK_STEP = 99, 5
CAPITAL_BONUS = {"2": 400, "yes": 400, "4": 150, "3": 150}
# Autocomplete: the best KEEP places of every prefix up to MAX letters are
# kept in a table of their own, so a letter or two asks a short table, not
# every town beginning with it.
PREFIX_MAX, PREFIX_KEEP = 4, 40
# A name followed by where it is (a qualifier that matched) ranks above one that was not.
QUALIFIED_BONUS = 100
SUGGEST_MAX = 8
COLUMNS = (
    "word TEXT", "name TEXT", "class TEXT", "lat REAL", "lng REAL",
    "region TEXT", "postal TEXT", "country TEXT", "iso TEXT", "local TEXT",
    "weight INTEGER",
)  # fmt: skip
TOP_COLUMNS = ("prefix TEXT",) + COLUMNS[1:]
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
                    elif vf in (4, 5):  # int, uint (a place's rank)
                        value = str(vv)
                    elif vf == 6:  # sint
                        value = str(_unzigzag(vv))
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


# Web Mercator's edge: the latitude its square world map stops at.
MERCATOR_MAX_LAT = 85.0511


def _xy(z, lat, lng):
    n = 2**z
    lat = max(min(lat, MERCATOR_MAX_LAT), -MERCATOR_MAX_LAT)
    fx = (lng + 180.0) / 360.0 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(fx), int(fy), fx - int(fx), fy - int(fy)


def read_places(archive):
    """Every city (zoom 9) and town (zoom 10) the map labels, once each:
    {(name, class, lat, lng): (lat, lng, extra)} keyed so one place cut by
    tile edges counts once; ``extra`` is the tags a row keeps (EXTRA_TAGS)."""
    found = {}

    def take(data, z, x, y):
        for tags, lat, lng in tile_places(data, z, x, y):
            cls = tags.get("class")
            name = _display_name(tags)
            if cls in CLASSES and name:
                extra = {k: tags[k] for k in EXTRA_TAGS if tags.get(k)}
                found.setdefault(
                    (name, cls, round(lat, 2), round(lng, 2)), (lat, lng, extra)
                )

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


def _tag_rank(tags):
    """A place's size order from its tags, the larger the better."""
    weight = CLASS_WEIGHT.get(tags.get("class"), 0)
    try:
        weight -= min(int(tags.get("rank", 0)), RANK_MAX) * RANK_STEP
    except ValueError:
        pass
    weight += CAPITAL_BONUS.get(tags.get("capital"), 0)
    return weight


def _where(extra, lat, lng):
    """(region, postal, country, iso) of a place: its tiles' own tags where
    they carry them, else the point's place in zimi.regions' outlines."""
    region = next((extra[k] for k in REGION_TAGS if extra.get(k)), "")
    country = next((extra[k] for k in COUNTRY_TAGS if extra.get(k)), "")
    postal = iso = ""
    if not (region and country):
        from zimi import regions

        at = regions.locate(lat, lng)
        if at:
            region = region or at["region"]
            country = country or at["country"]
            postal, iso = at["postal"], at["iso"]
    if iso not in POSTAL_COUNTRIES:
        postal = ""
    return region, postal, country, iso


def _rows(found):
    """The towns' rows, and the table of the best places of each short prefix.

    One row per word of each name (and of its local name):
    (word, name, class, lat, lng, region, postal, country, iso, local, weight).
    """
    rows, seen, tops = [], set(), {}
    for (name, cls, _la, _lo), (lat, lng, extra) in found.items():
        region, postal, country, iso = _where(extra, lat, lng)
        local = extra.get("name", "")
        if local == name:
            local = ""
        weight = _tag_rank({"class": cls, **extra})
        words = set(mapsearch.normalize_text(name).split())
        words |= set(mapsearch.normalize_text(local).split())
        for word in words:
            key = (word, name, cls, round(lat, 3), round(lng, 3))
            if key in seen:
                continue
            seen.add(key)
            row = (
                word, name, cls, round(lat, 5), round(lng, 5),
                region, postal, country, iso, local, weight,
            )  # fmt: skip
            rows.append(row)
            for n in range(1, min(len(word), PREFIX_MAX) + 1):
                tops.setdefault(word[:n], []).append(row)
    top_rows = []
    for prefix, group in tops.items():
        group.sort(key=lambda r: (-r[10], r[1]))
        top_rows.extend((prefix,) + r[1:] for r in group[:PREFIX_KEEP])
    return rows, top_rows


def build_places(zim_name, zim_path):
    """Read a map's towns into its file. Opens an archive of its own; runs
    in a child process for a big map."""
    archive = _srv.open_archive(zim_path)
    rows, top_rows = _rows(read_places(archive))
    return _builder.write(
        zim_name, zim_path, archive, rows,
        extra={"top": (TOP_COLUMNS, top_rows, ("prefix",))},
    )  # fmt: skip


def is_kiwix_map(z):
    """A Kiwix map: a map with tiles and no place index of its own."""
    return z.get("kind") == "map" and not z.get("map_search")


_lock = threading.Lock()
_builder = DetailsBuilder(
    "mapplaces",
    zims=is_kiwix_map,
    label="Maps",
    what="town names",
    # 3: each town's region, country, local name and size (autocomplete).
    version="3",
    table="places",
    columns=COLUMNS,
    # Looked up when it runs, as the child process looks it up.
    build=lambda name, path: build_places(name, path),
    load=None,
    lock=_lock,
    on_keep=lambda name, key, details: None,
    # word for a name; lat for near: (a box of latitudes, then the distance).
    indexes=("word", "lat"),
)
build_all = _builder.build_all


# ── the search ────────────────────────────────────────────────────────────


def ready(name):
    """Whether ``name``'s towns are read from the ZIM installed now. Asks for
    the read when they are not, so the first search on a new map starts it."""
    path = _srv.get_zim_files().get(name)
    if not path:
        return False
    got = _builder.kept(name, path)
    if got is not None:
        # Read: {} when the read failed, kept empty until the next start rather than read again on
        # every search (a world map takes minutes).
        return bool(got)
    _builder.request(name)
    return False


def _query(name, sql, args):
    try:
        conn = sqlite3.connect(_builder.path(name), timeout=5)
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as e:
        log.debug("map places %s: %s", name, e)
        return []


_KEYS = tuple(c.split()[0] for c in COLUMNS[1:])
_SELECT = ", ".join(_KEYS)


def _place(row):
    """A row of the file as a dict: the keys of COLUMNS after ``word``."""
    return dict(zip(_KEYS, row))


def _norm(text):
    """Words only: lower-case, accents and the punctuation of an address gone."""
    return " ".join(
        "".join(
            c if c.isalnum() or c.isspace() else " "
            for c in mapsearch.normalize_text(text)
        ).split()
    )


def _locality_parts(p):
    """["Illinois", "United States"] for a place: the region and country,
    left out where they repeat the name or each other (Paris, France)."""
    parts = []
    for part in (p.get("region"), p.get("country")):
        if part and _norm(part) not in (_norm(p["name"]), *map(_norm, parts)):
            parts.append(part)
    return parts


def locality(p):
    """"Illinois, United States" for a place."""
    return ", ".join(_locality_parts(p))


def label(p):
    """ "Springfield, Illinois, United States": what a suggestion is called."""
    return ", ".join([p["name"]] + ([loc] if (loc := locality(p)) else []))


def token(p):
    """What picking the place puts after ``near:``, readable and unambiguous
    enough to be resolved again: the name and the first part of its locality
    ("Springfield, Illinois"; "Paris, France"); the bare name when the map
    does not say where it is."""
    return ", ".join([p["name"]] + _locality_parts(p)[:1])


def _place_row(p):
    """A town as the map answers in (mapsearch.place_dict), zoomed for its class."""
    place = mapsearch.place_dict(
        {
            "n": p["name"],
            "t": "place",
            "s": p["class"],
            "a": p["lat"],
            "o": p["lng"],
            "l": locality(p),
        }
    )
    place["zoom"] = ZOOM_FOR_CLASS.get(p["class"], place["zoom"])
    if p.get("region"):
        place["region"] = p["region"]
    if p.get("country"):
        place["country"] = p["country"]
    if p.get("local"):
        place["local"] = p["local"]
    return place


def _forms(p):
    """Every way to write where a place is that a qualifier may use: the
    region (or its postal code), the country (or its code or a nickname), or
    both, in that order: "illinois", "il", "illinois united states", "il usa"."""
    from zimi import regions

    where = [w for w in (_norm(p["region"]), _norm(p["postal"])) if w]
    nations = [_norm(w) for w in regions.country_words(p["country"], p["iso"]) if w]
    forms = set(where) | set(nations)
    forms.update(f"{r} {c}" for r in where for c in nations)
    return forms


def qualifies(p, qualifier, prefix=False):
    """Whether a place is where ``qualifier`` says (normalized words): one of
    its forms, or, as it is being typed, the start of one."""
    if not qualifier:
        return True
    forms = _forms(p)
    return any(f.startswith(qualifier) for f in forms) if prefix else qualifier in forms


def splits(text):
    """How typed text may divide into a place's name and the qualifier after it,
    most likely first, as normalized (name, qualifier) pairs: after the first
    comma ("Springfield, IL"), else at each word ("Paris Texas", longest name
    first), the whole text last as a name alone."""
    if "," in text:
        name, _sep, rest = text.partition(",")
        return [(_norm(name), _norm(rest))]
    words = _norm(text).split()
    out = [
        (" ".join(words[:k]), " ".join(words[k:])) for k in range(len(words) - 1, 0, -1)
    ]
    return out + [(" ".join(words), "")]


def _fetch(name, words, qualified=False):
    """Candidate rows for typed ``words``, the largest places first: from the
    table of each short prefix's best when one word is short, else the rows
    whose word starts with the longest typed word."""
    first = max(words, key=len)
    # A qualifier asks for places the best few of a prefix may not include.
    if len(words) == 1 and len(first) <= PREFIX_MAX and not qualified:
        sql = f"SELECT {_SELECT} FROM top WHERE prefix = ? ORDER BY weight DESC"
        args = (first,)
    else:
        sql = (
            f"SELECT {_SELECT} FROM places WHERE word >= ? AND word < ?"
            " ORDER BY weight DESC LIMIT ?"
        )
        args = (first, first + "￿", CANDIDATES_MAX)
    return [_place(r) for r in _query(name, sql, args)]


def _best(name, typed, qualifier):
    """(score, place) for the towns matching a typed name and, when there is
    one, the qualifier being typed after it; best first."""
    words = typed.split()
    if not words:
        return []
    scored, seen = [], set()
    for p in _fetch(name, words, bool(qualifier)):
        if not qualifies(p, qualifier, prefix=True):
            continue
        key = (p["name"], round(p["lat"], 3), round(p["lng"], 3))
        if key in seen:
            continue
        seen.add(key)
        # A local name is matched like the display name, a little behind it.
        best = None
        for text, penalty in ((p["name"], 0), (p["local"], 1)):
            if not text:
                continue
            entry = {"n": text, "t": "place", "s": p["class"]}
            s = mapsearch.score(entry, typed, words)
            if s is not None and (best is None or s - penalty > best):
                best = s - penalty
        if best is not None:
            scored.append((best + (QUALIFIED_BONUS if qualifier else 0), p))
    scored.sort(key=lambda sp: (-sp[0], -sp[1]["weight"], sp[1]["name"], sp[1]["region"]))
    return scored


def search(name, query, limit=mapsearch.MAX_RESULTS):
    """Places on map ``name`` matching ``query``, best first, in the shape
    mapsearch.search_places answers in. The query may name where, after the
    name ("Springfield, IL", "Paris Texas"). [] until the map has been read."""
    if not _norm(query) or not ready(name):
        return []
    scored, seen = [], set()
    for typed, qualifier in splits(query):
        for s, p in _best(name, typed, qualifier):
            key = (p["name"], round(p["lat"], 3), round(p["lng"], 3))
            if key not in seen:
                seen.add(key)
                scored.append((s, p))
    scored.sort(key=lambda sp: (-sp[0], -sp[1]["weight"], sp[1]["name"], sp[1]["region"]))
    out = []
    for s, p in scored[:limit]:
        place = _place_row(p)
        place["score"] = s
        out.append(place)
    return out


def suggest(name, query, limit=SUGGEST_MAX):
    """Autocomplete for a place being typed: search(), each place with the
    ``label`` it is offered as and the ``token`` picking it puts after near:."""
    out = []
    for place in search(name, query, limit):
        p = {
            "name": place["name"],
            "region": place.get("region", ""),
            "country": place.get("country", ""),
        }
        place["label"] = label(p)
        place["token"] = token(p)
        out.append(place)
    return out


# ── near: places within a distance of a place ─────────────────────────────

KM_PER_DEGREE_LAT = 111.32
# The most places a near: answers with, nearest first.
NEAR_MAX_RESULTS = 30


def named(name, place, qualified_only=False):
    """Every place on map ``name`` called ``place`` (case and accents aside),
    and, when the text names where after the name ("Springfield, IL", "Paris
    Texas"), only those there: [{"name", "sub", "lat", "lng", "region",
    "country", ...}]. ``qualified_only`` leaves out the reading with no
    qualifier. [] until the map has been read."""
    if not _norm(place) or not ready(name):
        return []
    # The whole text as a name first: "New York" is a place, not "New" in York.
    for typed, qualifier in sorted(splits(place), key=lambda s: bool(s[1])):
        if qualified_only and not qualifier:
            continue
        words = typed.split()
        rows = _query(
            name,
            f"SELECT DISTINCT {_SELECT} FROM places WHERE word = ?",
            (max(words, key=len),),
        )
        found = [
            p
            for p in map(_place, rows)
            if typed in (_norm(p["name"]), _norm(p["local"]))
            and qualifies(p, qualifier)
        ]
        if found:
            return [dict(p, sub=p["class"]) for p in found]
    return []


def pick(candidates, at=None):
    """The one of several places of a name a near: means: the nearest to
    ``at`` (the person's own place) when there is one, else the largest."""
    if not candidates:
        return None
    if at:
        return min(
            candidates, key=lambda p: km_between(at[0], at[1], p["lat"], p["lng"])
        )
    return max(candidates, key=lambda p: p.get("weight", 0))


def _lng_ranges(lng, dlng):
    """The longitude ranges a box of half-width ``dlng`` covers: two where
    it crosses the antimeridian, the whole circle when it is wider."""
    if dlng >= 180:
        return [(-180.0, 180.0)]
    lo, hi = lng - dlng, lng + dlng
    if lo < -180:
        return [(lo + 360, 180.0), (-180.0, hi)]
    if hi > 180:
        return [(lo, 180.0), (-180.0, hi - 360)]
    return [(lo, hi)]


def near(name, lat, lng, radius_km, words=(), limit=NEAR_MAX_RESULTS):
    """Places on map ``name`` within ``radius_km`` of ``lat``, ``lng``,
    nearest first, each with ``km``; ``words`` (normalized) must all be in
    a name. The index gives a box of latitudes; the distance decides."""
    if not ready(name):
        return []
    dlat = radius_km / KM_PER_DEGREE_LAT
    cos = math.cos(math.radians(min(abs(lat) + dlat, 89.9)))
    dlng = radius_km / (KM_PER_DEGREE_LAT * max(cos, 1e-6))
    found = {}
    for lo, hi in _lng_ranges(lng, dlng):
        rows = _query(
            name,
            f"SELECT DISTINCT {_SELECT} FROM places"
            " WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?",
            (lat - dlat, lat + dlat, lo, hi),
        )
        for row in rows:
            p = _place(row)
            km = km_between(lat, lng, p["lat"], p["lng"])
            if km > radius_km:
                continue
            norm = mapsearch.normalize_text(p["name"])
            if any(w not in norm for w in words):
                continue
            found[(p["name"], round(p["lat"], 3), round(p["lng"], 3))] = (
                km,
                p["name"],
                p,
            )
    out = []
    for km, _n, p in sorted(found.values(), key=lambda v: v[:2])[:limit]:
        place = _place_row(p)
        place["km"] = round(km, 1)
        out.append(place)
    return out


def _reset_for_tests():
    _builder.forget()
