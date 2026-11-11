"""Build the Almanac's HD flavour: the whole Almanac plus the HD tile pyramids, one ZIM.

    python scripts/build_almanac_maxi.py [--tiles FILE] [--out DIR] [--cache DIR] [--tag vX.Y.Z]

Two flavours of one Name, the way Kiwix ships them: ``zimi_almanac_<month>.zim`` (the Almanac, small, in the
package) and ``zimi_almanac_maxi_<month>.zim`` (Flavour ``maxi``: the same Almanac with the tiles inside, under
``hd/``). Opened alone in Kiwix the maxi flavour is the whole Almanac whose 3D view draws the sharp tiles from its own
ZIM (``hd/hd.json`` is what tells it they are there); in Zimi, where the Almanac runs from the app, the file is the
tile library, found by name.

The tiles take about an hour to make (scripts/build_almanac_hd.py: NASA downloads), and the Almanac changes every
release, so the tiles are an immutable input: the *tile source* is a ZIM of tiles only, attached once to a release and
pinned in ``zimi/assets/almanac-tiles.json`` ({file, size, sha256, tag}). This script reads the tiles out of it and
writes the flavour in minutes, on every release (desktop-release.yml). With ``--tag`` it also writes
``zimi_almanac_maxi.json`` ({file, size, sha256, tag}), the manifest Zimi reads from its own release to offer and
fetch the file (zimi/almanachd.py).
"""

import argparse
import datetime
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PIN = os.path.join(ROOT, "zimi", "assets", "almanac-tiles.json")
RELEASE_URL = "https://github.com/epheterson/Zimi/releases/download/{tag}/{file}"
FLAVOUR = "maxi"
FILE_FMT = "zimi_almanac_maxi_%s.zim"
#: Maximum: every layer at its source's full resolution (zimi/almanachd.py), attached as zimsplit chunks.
MAX_FLAVOUR = "ultra"
MAX_FILE_FMT = "zimi_almanac_ultra_%s.zim"
#: HD is Maximum's tiles with these stopped short, the one file under 2 GiB (1.98 GB in 2026-11): Mars's and Mercury's
#: colour at level 6, every body's heights at level 3. Everything else is the same in both.
HD_CAPS = {"planets/mars": 6, "planets/mercury": 6}
HD_TERRAIN_CAP = 3
MANIFEST = "zimi_almanac_maxi.json"
#: Where the tiles sit inside the flavour (beside index.html, so a relative URL from the page reaches them).
TILE_ROOT = "hd/"
MIMES = {".webp": "image/webp", ".json": "application/json", ".zcr2": "application/octet-stream"}
#: Where the craft models sit inside the flavour (scripts/build_craft_hd.py writes the folder).
CRAFT_ROOT = TILE_ROOT + "craft/"
#: What of the tile source is not a tile: its own credits page.
SKIP = ("index.html",)
HASH_CHUNK = 1 << 20


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(HASH_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def read_pin(path=PIN):
    with open(path, encoding="utf-8") as f:
        pin = json.load(f)
    if not all(
        isinstance(pin.get(k), str) and pin[k] for k in ("file", "sha256", "tag")
    ):
        raise SystemExit("%s names no tile source" % path)
    return pin


def _download(url, path, sha):
    """``url`` into ``path``, unless it is there already with ``sha``; refused when it does not have that sha256."""
    if os.path.exists(path) and sha256_file(path) == sha:
        return path
    part = path + ".part"
    with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
        while True:
            chunk = r.read(HASH_CHUNK)
            if not chunk:
                break
            f.write(chunk)
    if sha256_file(part) != sha:
        os.remove(part)
        raise SystemExit("%s is not the pinned tile source (sha256 differs)" % os.path.basename(path))
    os.replace(part, path)
    return path


def _sha256_files(paths):
    h = hashlib.sha256()
    for p in paths:
        with open(p, "rb") as f:
            for block in iter(lambda: f.read(HASH_CHUNK), b""):
                h.update(block)
    return h.hexdigest()


def fetch_tiles(cache, pin=None):
    """The pinned tile source in ``cache`` (downloaded once, checked against its sha256). A tile source bigger than a
    release file can be (Maximum's tiles: 4.8 GB) is pinned as zimsplit ``chunks``, each checked, then the whole
    book; the path returned is then its ``.zimaa``, which libzim reads as one archive."""
    pin = pin or read_pin()
    os.makedirs(cache, exist_ok=True)
    chunks = pin.get("chunks")
    if not chunks:
        return _download(RELEASE_URL.format(tag=pin["tag"], file=pin["file"]), os.path.join(cache, pin["file"]), pin["sha256"])
    paths = [
        _download(RELEASE_URL.format(tag=pin["tag"], file=c["file"]), os.path.join(cache, c["file"]), c["sha256"])
        for c in chunks
    ]
    if _sha256_files(paths) != pin["sha256"]:
        raise SystemExit("%s: the chunks are not the pinned tile source (sha256 differs)" % pin["file"])
    return paths[0]


def _date(name):
    import re

    m = re.search(r"_(\d{4}-\d{2})([a-z]?)\.zim", name)
    return (m.group(1), m.group(2)) if m else (None, None)


def unshipped_month(stems, shipped, floor=None, today=None):
    """The ``<month><letter>`` both flavours are named with: this month, after the last letter any release already
    shipped for either stem (a name, once released, is spent: Kiwix's letter for a second build in a month), and never
    below ``floor`` (the tile source's own, so a build is never older-named than files its tiles were made for)."""
    month = today or datetime.date.today().strftime("%Y-%m")
    used = [""]
    for name in shipped:
        for stem in stems:
            if name.startswith(stem + "_"):
                m, letter = _date(name)
                if m == month:
                    used.append(letter or "@")   # "@": the bare month, before "a"
    last = max(used)
    letter = "" if last == "" else ("a" if last == "@" else chr(min(ord(last) + 1, ord("z"))))
    if floor:
        fm, fl = _date("x_%s.zim" % floor)
        if fm == month and fl and (letter == "" or letter < fl):
            letter = fl
    return month + letter


def shipped_assets(repo="epheterson/Zimi"):
    """Every file name any release of ``repo`` carries (gh, with the job's token)."""
    import subprocess

    out = subprocess.run(
        ["gh", "api", "repos/%s/releases" % repo, "--paginate", "--jq", ".[].assets[].name"],
        capture_output=True, text=True, timeout=120, check=True,
    )
    return set(out.stdout.split())


def cap_of(layer, caps):
    """The deepest level ``caps`` keeps of ``layer``, or None (all of it)."""
    if caps is None:
        return None
    if layer in caps:
        return caps[layer]
    return caps.get("terrain/*") if layer.startswith("terrain/") else None


def hd_caps():
    return dict(HD_CAPS, **{"terrain/*": HD_TERRAIN_CAP})


def _capped_manifest(data, caps):
    """hd.json with each capped layer stopped at its cap: a layer cut short loses its deepest level's own size (``px``,
    every level above is a full tile) and the inserts that hang under it."""
    man = json.loads(data)
    for layer, spec in man.get("layers", {}).items():
        cap = cap_of(layer, caps)
        if cap is not None and spec.get("max", 0) > cap:
            spec["max"] = cap
            spec.pop("px", None)
            spec.pop("inserts", None)
    return json.dumps(man, separators=(",", ":")).encode()


def tile_entries(tiles_zim, caps=None):
    """``(path, mimetype, bytes)`` of every tile and the layer list in a tile source, under TILE_ROOT; with ``caps``
    ({layer: deepest level}, ``terrain/*`` for every body's heights), the levels past a layer's cap left out."""
    from libzim.reader import Archive

    from zimi.libzimcompat import entry_by_id

    archive = Archive(tiles_zim)
    found = 0
    for i in range(archive.all_entry_count):
        entry = entry_by_id(archive, i)
        ext = os.path.splitext(entry.path)[1]
        # The ZIM's own metadata has no extension; its credits page is not a tile.
        if entry.is_redirect or entry.path in SKIP or ext not in MIMES:
            continue
        data = None
        if caps is not None:
            bits = entry.path.split("/")
            at = next((k for k, b in enumerate(bits) if b.isdigit()), None)
            if at is not None:
                cap = cap_of("/".join(bits[:at]), caps)
                if cap is not None and int(bits[at]) > cap:
                    continue
            elif entry.path == "hd.json":
                data = _capped_manifest(bytes(entry.get_item().content), caps)
        found += 1
        yield TILE_ROOT + entry.path, MIMES[ext], data if data is not None else bytes(entry.get_item().content)
    if not found:
        raise SystemExit("%s holds no tiles" % tiles_zim)


def craft_entries(craft_dir):
    """``(path, mimetype, bytes)`` of every file the HD craft builder wrote, under CRAFT_ROOT."""
    for name in sorted(os.listdir(craft_dir)):
        ext = os.path.splitext(name)[1]
        if ext in MIMES:
            with open(os.path.join(craft_dir, name), "rb") as f:
                yield CRAFT_ROOT + name, MIMES[ext], f.read()


def add_tiles(tiles_zim, craft_dir=None, caps=None):
    """The ``extra_items`` hook (creator.create_folder_zim): tiles streamed in, never staged on disk; the HD craft
    folder, if there is one, beside them."""
    from zimi.zimwriter import make_asset_item

    def add(creator):
        names = set()
        for path, mime, data in tile_entries(tiles_zim, caps):
            names.add(path)
            creator.add_item(make_asset_item(path, mime, data))
        if TILE_ROOT + "hd.json" not in names:
            raise SystemExit("%s has no hd.json" % tiles_zim)
        for path, mime, data in craft_entries(craft_dir) if craft_dir else ():
            creator.add_item(make_asset_item(path, mime, data))

    return add


def build(tiles_zim, out_dir, month=None, craft_dir=None, flavour=FLAVOUR, caps=None):
    """A flavour of the Almanac (HD, ``maxi``, by default; Maximum is ``ultra``), built from the source as it is now
    with the tile source's tiles inside, ``caps`` cutting layers short. Returns its path."""
    from zimi import ownzims

    own = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
    month = month or datetime.date.today().strftime("%Y-%m")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, (MAX_FILE_FMT if flavour == MAX_FLAVOUR else FILE_FMT) % month)
    return ownzims.write_zim(
        own, path, flavour=flavour, extra_items=add_tiles(tiles_zim, craft_dir, caps)
    )


def build_release(tiles_zim, out_dir, tag, month, craft_dir=None):
    """Everything a release carries for Almanac HD, in ``out_dir``: HD (one file), Maximum as chunks under GitHub's
    2 GiB a file (the whole book is not kept), and the manifest naming every file with its size and sha256. A tile
    source with no levels past HD's caps (an older, HD-only pin) makes HD alone, and the manifest has no Maximum."""
    hd = build(tiles_zim, out_dir, month, craft_dir, FLAVOUR, hd_caps())
    print("built %s (%.1f MB)" % (hd, os.path.getsize(hd) / 1e6), flush=True)
    max_book = max_chunks = None
    if _has_more_than(tiles_zim, hd_caps()):
        max_book = build(tiles_zim, out_dir, month, craft_dir, MAX_FLAVOUR, None)
        max_chunks = split_book(max_book, out_dir, part=CHUNK_BYTES)
        print("built %s (%.1f MB) as %d chunks" % (max_book, os.path.getsize(max_book) / 1e6, len(max_chunks)), flush=True)
    manifest = write_manifest(hd, tag, out_dir, max_book=max_book, max_chunks=max_chunks)
    if max_book:
        os.remove(max_book)   # the chunks are what ships
    return hd, max_chunks or [], manifest


def _has_more_than(tiles_zim, caps):
    """Whether the tile source holds a level past ``caps`` anywhere: Maximum would differ from HD."""
    from libzim.reader import Archive

    man = json.loads(bytes(Archive(tiles_zim).get_entry_by_path("hd.json").get_item().content))
    return any(cap_of(k, caps) is not None and v.get("max", 0) > cap_of(k, caps) for k, v in man["layers"].items())


#: Maximum's chunks: under GitHub's 2 GiB a release file, with room.
CHUNK_BYTES = 2_000_000_000


def cluster_offsets(path):
    """Where each cluster of the ZIM at ``path`` starts, from its header and cluster pointer list
    (https://wiki.openzim.org/wiki/ZIM_file_format)."""
    import struct

    header = struct.Struct("<IHH16sIIQQQQIIQ")
    with open(path, "rb") as f:
        fields = header.unpack(f.read(header.size))
        clusters, cluster_ptr = fields[5], fields[8]
        f.seek(cluster_ptr)
        return list(struct.unpack("<%dQ" % clusters, f.read(8 * clusters)))


def split_book(path, out_dir, part=CHUNK_BYTES):
    """The ZIM at ``path`` as zimsplit's chunks in ``out_dir`` (``name.zimaa``, ``name.zimab``...), cut only between
    clusters, each up to ``part`` bytes (a cluster bigger than that is a chunk of its own). A cut through a cluster
    leaves libzim unable to read the full-text index (tests/test_split_zim.py shows it). Returns the chunk paths."""
    from zimi import zimparts

    size = os.path.getsize(path)
    bounds = sorted(set([0, size] + cluster_offsets(path)))
    cuts, start = [0], 0
    for lo, hi in zip(bounds, bounds[1:]):
        if lo > start and hi - start > part:
            cuts.append(lo)
            start = lo
    cuts.append(size)
    os.makedirs(out_dir, exist_ok=True)
    out = []
    with open(path, "rb") as src:
        for suffix, (lo, hi) in zip(zimparts._SUFFIXES, zip(cuts, cuts[1:])):
            dest = os.path.join(out_dir, os.path.basename(path) + suffix)
            src.seek(lo)
            left = hi - lo
            with open(dest + ".part", "wb") as f:
                while left:
                    block = src.read(min(left, HASH_CHUNK * 8))
                    f.write(block)
                    left -= len(block)
            os.replace(dest + ".part", dest)
            out.append(dest)
    return out


def write_manifest(path, tag, out_dir=None, max_book=None, max_chunks=None):
    """What Zimi reads from the release ``tag``: the file, its size and checksum; with ``max_book`` (the Maximum
    flavour) and its ``max_chunks`` (split_book), Maximum's entry: the book's size and sha256 and each chunk's."""
    manifest = {
        "file": os.path.basename(path),
        "size": os.path.getsize(path),
        "sha256": sha256_file(path),
        "tag": tag,
    }
    if max_book:
        manifest["max"] = {
            "file": os.path.basename(max_book),
            "size": os.path.getsize(max_book),
            "sha256": sha256_file(max_book),
            "chunks": [{"file": os.path.basename(c), "size": os.path.getsize(c), "sha256": sha256_file(c)} for c in max_chunks],
        }
    target = os.path.join(out_dir or os.path.dirname(path), MANIFEST)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    return target


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--tiles",
        help="the tile source ZIM (default: the pinned one, downloaded into --cache)",
    )
    ap.add_argument("--cache", default=os.path.join(ROOT, "build", "almanac-tiles"))
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    ap.add_argument(
        "--craft",
        help="the HD craft folder (scripts/build_craft_hd.py --out): carried as hd/craft/",
    )
    ap.add_argument(
        "--tag",
        help="the release the files go on: builds HD and Maximum (as chunks) and writes the manifest naming them",
    )
    ap.add_argument(
        "--month",
        help="the files' <month><letter> (default: this month, after the last letter any release shipped; needs gh)",
    )
    a = ap.parse_args(argv)
    tiles = a.tiles or fetch_tiles(a.cache)
    if not a.tag:
        path = build(tiles, a.out, month=a.month, craft_dir=a.craft)
        print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
        return 0
    tm, tl = _date(os.path.basename(tiles))   # the tile source's own <month><letter> (.zim or .zimaa)
    month = a.month or unshipped_month(
        ("zimi_almanac_maxi", "zimi_almanac_ultra"), shipped_assets(), floor=tm and tm + tl
    )
    hd, chunks, manifest = build_release(tiles, a.out, a.tag, month, a.craft)
    print("wrote", manifest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
