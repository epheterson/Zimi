"""Place search over a StreetZim map's own index.

StreetZim (an offline OpenStreetMap ZIM built by create_osm_zim) keeps its
places in ``search-data/``: a ``manifest.json`` naming the chunks, and one
JSON array per two-character key (``ka.json``), each entry a place::

    {"n": "Kailua", "t": "place", "s": "city", "a": 21.40, "o": -157.74, "l": "Honolulu"}

n is the name, t the type, s the sub-type, a and o latitude and longitude,
l the locality. Hot keys are fanned out into hashed sub-chunks (``sa-0`` ..
``sa-f``, sometimes two levels deep) and the manifest's ``sub_chunks`` says
which. The scheme is StreetZim's, ported here line for line from its
index.html so a query from Zimi's search bar answers the way the map's own
box would. It is the only way to search these maps from outside: the places
are not entries the title index can see, and the map honours no search
deep link (StreetZim issue #18 asks for one).

Kiwix's maps2zim ZIMs do not have this index; their places are title
entries and the ordinary search finds them.

Bounded on purpose. A key like ``sa`` ("San Francisco", "Sacramento", "San
Jose") can fan out to 256 sub-chunks of a megabyte each. The map's own box
streams them; a server answering a search bar reads at most
``MAX_CHUNKS`` and says nothing about the rest, which is the right trade at
one search.
"""

import json
import random
import logging
import math
import re
import unicodedata

log = logging.getLogger("zimi")

MANIFEST_PATH = "search-data/manifest.json"
CHUNK_DIR = "search-data/"
MAX_CHUNKS = 12  # per query, across all prefixes
MAX_RESULTS = 15  # what StreetZim's own box shows
_MANIFEST_MAX_BYTES = 8 * 1024 * 1024
_CHUNK_MAX_BYTES = 8 * 1024 * 1024

# How far in to fly for a picked result, by type. StreetZim's selectResult.
ZOOM_FOR_TYPE = {
    "place": 14,
    "airport": 14,
    "peak": 15,
    "park": 15,
    "water": 14,
    "poi": 17,
    "street": 16,
}
_DEFAULT_ZOOM = 15

# StreetZim's scoring, kept as it is so the two boxes agree.
_TYPE_BONUS = {
    "place": 20,
    "airport": 15,
    "peak": 10,
    "park": 10,
    "water": 5,
    "poi": 5,
    "building": 3,
    "street": 0,
}
_PLACE_SUB_BONUS = {
    "city": 200,
    "county": 80,
    "region": 60,
    "town": 30,
    "suburb": 10,
    "village": 8,
    "neighbourhood": 4,
}

# One manifest per archive, keyed by the archive's filename. A manifest is a
# few KB and never changes for a given file.
_manifests = {}


def normalize_text(s):
    """StreetZim's normalizeText: NFKD, marks stripped, lower-cased."""
    return "".join(
        ch
        for ch in unicodedata.normalize("NFKD", s or "")
        if not unicodedata.combining(ch)
    ).lower()


def _ascii_norm(ch):
    if ch == "_" or ("0" <= ch <= "9") or ("a" <= ch <= "z"):
        return ch
    return "_"


def key_for(word):
    """StreetZim's keyFor: the chunk a word's index lives in.

    Two ASCII-normalised characters (a-z, 0-9, _), or ``u`` plus the hex
    code point for a word that does not start in ASCII (CJK, Cyrillic,
    Arabic...). Must match the writer, ``_prefix_key`` in create_osm_zim.py.
    """
    if not word:
        return "__"
    c0 = word[0]
    if ord(c0) >= 128:
        return "u" + format(ord(c0), "x")
    k0 = _ascii_norm(c0)
    k1 = "_"
    if len(word) >= 2:
        c1 = word[1]
        k1 = "_" if ord(c1) >= 128 else _ascii_norm(c1)
    return k0 + k1


def _expand_prefix(key, manifest, seen, out):
    """StreetZim's expandPrefix: a key, or the sub-chunks it was split into."""
    if key in seen:
        return
    seen.add(key)
    chunks = manifest.get("chunks") or {}
    subs = manifest.get("sub_chunks") or {}
    if key in chunks:
        out.append(key)
        return
    direct = subs.get(key)
    if direct:
        for sub in direct:
            _expand_prefix(sub, manifest, seen, out)
        return
    prefix = key + "-"
    found = False
    for sk in subs:
        if sk.startswith(prefix):
            found = True
            _expand_prefix(sk, manifest, seen, out)
    if found:
        return
    for ck in chunks:
        if ck.startswith(prefix) and ck not in seen:
            seen.add(ck)
            out.append(ck)


def prefixes_for(query, manifest):
    """StreetZim's getPrefixes: every chunk key a query could live in."""
    q = normalize_text(query).strip()
    words = [w for w in re.split(r"\s+", q) if w]
    seen = set()
    out = []
    for w in words:
        _expand_prefix(key_for(w), manifest, seen, out)
    _expand_prefix(key_for(q), manifest, seen, out)
    if len(q) < 2:
        c = q[:1]
        for ck in manifest.get("chunks") or {}:
            if ck.startswith(c) and ck not in seen:
                seen.add(ck)
                out.append(ck)
    return out


def _read_json(archive, path, max_bytes):
    """A JSON entry of the archive, or None. Never raises: a map missing a
    chunk the manifest names is a map with fewer places, not an error."""
    try:
        item = archive.get_entry_by_path(path).get_item()
        if item.size > max_bytes:
            log.debug(
                "%s: %s is %d bytes, over the cap",
                getattr(archive, "filename", "?"),
                path,
                item.size,
            )
            return None
        return json.loads(bytes(item.content).decode("utf-8", "replace"))
    except Exception as e:
        log.debug("%s: no %s (%s)", getattr(archive, "filename", "?"), path, e)
        return None


def manifest_for(archive):
    """The map's search manifest, read once per archive file. None when the
    archive carries no place index, which is every non-StreetZim ZIM."""
    key = getattr(archive, "filename", None) or id(archive)
    if key in _manifests:
        return _manifests[key]
    manifest = _read_json(archive, MANIFEST_PATH, _MANIFEST_MAX_BYTES)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("chunks"), dict):
        manifest = None
    _manifests[key] = manifest
    return manifest


def has_place_index(archive):
    return manifest_for(archive) is not None


def score(entry, query_norm, words):
    """StreetZim's scoreResults for one entry, without the proximity term:
    a search bar has no map centre to be near. None when a word is missing."""
    name = normalize_text(entry.get("n", ""))
    text_score = 0
    for w in words:
        pos = name.find(w)
        if pos == -1:
            return None
        if pos == 0 or name[pos - 1] == " ":
            text_score += 10
        text_score += 1
    if name == query_norm:
        text_score += 50
    if name.startswith(query_norm):
        text_score += 25
    text_score += _TYPE_BONUS.get(entry.get("t"), 0)
    if entry.get("t") == "place" and entry.get("s"):
        text_score += _PLACE_SUB_BONUS.get(entry.get("s"), 0)
    return text_score


def search_places(archive, query, limit=MAX_RESULTS, max_chunks=MAX_CHUNKS):
    """Places on this map matching ``query``, best first.

    Each result: ``{name, type, sub, lat, lng, locality, zoom, score}``.
    Empty for a map without a place index, an empty query, or nothing found.
    """
    manifest = manifest_for(archive)
    q = normalize_text(query).strip()
    if manifest is None or not q:
        return []
    words = [w for w in re.split(r"\s+", q) if w]
    keys = prefixes_for(q, manifest)
    if len(keys) > max_chunks:
        log.debug(
            "%s: query %r spans %d chunks, reading %d",
            getattr(archive, "filename", "?"),
            query,
            len(keys),
            max_chunks,
        )
        keys = keys[:max_chunks]
    matches = []
    seen = set()
    for key in keys:
        entries = _read_json(archive, CHUNK_DIR + key + ".json", _CHUNK_MAX_BYTES)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            dedup = (entry.get("n"), entry.get("a"), entry.get("o"))
            if dedup in seen:
                continue
            seen.add(dedup)
            s = score(entry, q, words)
            if s is None:
                continue
            lat, lng = entry.get("a"), entry.get("o")
            if not (isinstance(lat, (int, float)) and isinstance(lng, (int, float))):
                continue
            if not (math.isfinite(lat) and math.isfinite(lng)):
                continue
            matches.append((s, entry))
    matches.sort(key=lambda m: -m[0])
    out = []
    for s, e in matches[:limit]:
        out.append(
            {
                "name": e.get("n", ""),
                "type": e.get("t", ""),
                "sub": e.get("s", "") or "",
                "lat": round(float(e["a"]), 5),
                "lng": round(float(e["o"]), 5),
                "locality": e.get("l", "") or "",
                "zoom": ZOOM_FOR_TYPE.get(e.get("t"), _DEFAULT_ZOOM),
                "score": s,
            }
        )
    return out


def _place_dict(e):
    return {
        "name": e.get("n", ""),
        "type": e.get("t", ""),
        "sub": e.get("s", "") or "",
        "lat": round(float(e["a"]), 5),
        "lng": round(float(e["o"]), 5),
        "locality": e.get("l", "") or "",
        "zoom": ZOOM_FOR_TYPE.get(e.get("t"), _DEFAULT_ZOOM),
    }


def _has_coords(e):
    lat, lng = e.get("a"), e.get("o")
    return (
        isinstance(lat, (int, float))
        and isinstance(lng, (int, float))
        and math.isfinite(lat)
        and math.isfinite(lng)
    )


def random_place(archive, rng=None):
    """Somewhere on this map, for the dice: one chunk of the place index
    drawn by how many places it holds, then one place in it. A named place
    over an address when the chunk has one, and a settlement over the rest;
    an address is a fine surprise too when that is all there is. None for a map
    without a place index or an empty one."""
    rng = rng or random
    manifest = manifest_for(archive)
    if manifest is None:
        return None
    chunks = manifest.get("chunks") or {}
    keys = list(chunks)
    if not keys:
        return None
    weights = [chunks[k] if isinstance(chunks[k], (int, float)) and chunks[k] > 0 else 1 for k in keys]
    for _ in range(4):  # a chunk the manifest names but the map lacks
        key = rng.choices(keys, weights=weights)[0]
        entries = _read_json(archive, CHUNK_DIR + key + ".json", _CHUNK_MAX_BYTES)
        if not isinstance(entries, list):
            continue
        usable = [e for e in entries if isinstance(e, dict) and _has_coords(e)]
        if not usable:
            continue
        # A settlement first (a town is a surprise you can name), then any
        # named thing, then an address when that is all the chunk holds.
        towns = [e for e in usable if e.get("t") == "place"]
        named = [e for e in usable if e.get("t") != "address"]
        return _place_dict(rng.choice(towns or named or usable))
    return None


def _reset_for_tests():
    _manifests.clear()
