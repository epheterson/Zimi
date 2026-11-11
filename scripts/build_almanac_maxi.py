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
MANIFEST = "zimi_almanac_maxi.json"
#: Where the tiles sit inside the flavour (beside index.html, so a relative URL from the page reaches them).
TILE_ROOT = "hd/"
MIMES = {
    ".webp": "image/webp",
    ".json": "application/json",
    ".zcr2": "application/octet-stream",
}
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


def fetch_tiles(cache, pin=None):
    """The pinned tile source in ``cache`` (downloaded once, checked against its sha256)."""
    pin = pin or read_pin()
    path = os.path.join(cache, pin["file"])
    if os.path.exists(path) and sha256_file(path) == pin["sha256"]:
        return path
    os.makedirs(cache, exist_ok=True)
    part = path + ".part"
    url = RELEASE_URL.format(tag=pin["tag"], file=pin["file"])
    with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
        while True:
            chunk = r.read(HASH_CHUNK)
            if not chunk:
                break
            f.write(chunk)
    if sha256_file(part) != pin["sha256"]:
        os.remove(part)
        raise SystemExit(
            "%s is not the pinned tile source (sha256 differs)" % pin["file"]
        )
    os.replace(part, path)
    return path


def tile_entries(tiles_zim):
    """``(path, mimetype, bytes)`` of every tile and the layer list in a tile source, under TILE_ROOT."""
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
        found += 1
        yield TILE_ROOT + entry.path, MIMES[ext], bytes(entry.get_item().content)
    if not found:
        raise SystemExit("%s holds no tiles" % tiles_zim)


def craft_entries(craft_dir):
    """``(path, mimetype, bytes)`` of every file the HD craft builder wrote, under CRAFT_ROOT."""
    for name in sorted(os.listdir(craft_dir)):
        ext = os.path.splitext(name)[1]
        if ext in MIMES:
            with open(os.path.join(craft_dir, name), "rb") as f:
                yield CRAFT_ROOT + name, MIMES[ext], f.read()


def add_tiles(tiles_zim, craft_dir=None):
    """The ``extra_items`` hook (creator.create_folder_zim): tiles streamed in, never staged on disk; the HD craft
    folder, if there is one, beside them."""
    from zimi.zimwriter import make_asset_item

    craft = list(craft_entries(craft_dir)) if craft_dir else []
    has_craft = CRAFT_ROOT + "index.json" in [c[0] for c in craft]

    def add(creator):
        names = set()
        for path, mime, data in tile_entries(tiles_zim):
            names.add(path)
            if path == TILE_ROOT + "hd.json":
                data = with_craft(data, has_craft)
            creator.add_item(make_asset_item(path, mime, data))
        if TILE_ROOT + "hd.json" not in names:
            raise SystemExit("%s has no hd.json" % tiles_zim)
        for path, mime, data in craft:
            creator.add_item(make_asset_item(path, mime, data))

    return add


def with_craft(manifest_bytes, has_craft):
    """The tile source's ``hd.json`` saying whether the flavour carries the HD craft (``"craft": true``): the 3D view
    asks for ``craft/index.json`` only then, never a 404 on every open."""
    manifest = json.loads(manifest_bytes)
    if has_craft:
        manifest["craft"] = True
    else:
        manifest.pop("craft", None)
    return json.dumps(manifest, separators=(",", ":")).encode()


def build(tiles_zim, out_dir, month=None, craft_dir=None):
    """The HD flavour of the Almanac, built from the source as it is now. Returns its path."""
    from zimi import ownzims

    own = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
    month = month or datetime.date.today().strftime("%Y-%m")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, FILE_FMT % month)
    return ownzims.write_zim(
        own, path, flavour=FLAVOUR, extra_items=add_tiles(tiles_zim, craft_dir)
    )


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
        "--tag", help="the release the file goes on: also writes the manifest for it"
    )
    a = ap.parse_args(argv)
    tiles = a.tiles or fetch_tiles(a.cache)
    path = build(tiles, a.out, craft_dir=a.craft)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    if a.tag:
        print("wrote", write_manifest(path, a.tag))
    return 0


if __name__ == "__main__":
    sys.exit(main())
