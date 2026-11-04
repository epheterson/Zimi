"""Build Almanac HD: the Earth and the Moon as tile pyramids, one ZIM.

    python scripts/build_almanac_hd.py [--cache DIR] [--out DIR] [--max-earth N] [--update-pins]

The Almanac draws the Earth and the Moon from one small map each, fetched with
the page. Almanac HD is the sharp version: each body's map cut into 512 px
tiles, level by level, so the 3D view (almanac-earth.js) asks only for the
tiles in view at the detail the screen can show. It is a ZIM of its own, built
here and attached to a release (never committed: hundreds of MB), and Zimi
downloads it once, when someone opening the Almanac says yes.

Tiling: plate carree, the same as the maps already shipped. Level z holds
2^(z+1) columns by 2^z rows of square tiles, 180 / 2^z degrees on a side;
column 0 starts at longitude -180, row 0 at latitude +90. A tile is
``<body>/<layer>/<z>/<x>/<y>.webp``. ``hd.json`` at the root lists each layer's
deepest level, so a client never asks for a tile that is not there.

Sources (all public domain, credited in the ZIM's index page and in
zimi/static/earth/SOURCES.txt):
  earth/day    NASA Blue Marble: Next Generation, through NASA GIBS (500 m set,
               level 7, 0.0044 deg a pixel). Deepest level 6: 610 m a pixel,
               the finest the 500 m mosaic holds without inventing pixels.
  earth/night  NASA Black Marble 2016 (VIIRS), through NASA GIBS, greyscale.
  moon/relief  NASA SVS CGI Moon Kit, LOLA elevation at 64 pixels a degree
               (ldem_64_uint.tif, half-metres), as surface normals: east and
               north tilt in red and green, square-root companded (a mare's
               tenth-of-a-degree slopes would band at 8 bits under a low Sun),
               so the Moon's own shader lights every crater wall and ridge
               from the Sun of the moment.
  moon/albedo  NASA SVS CGI Moon Kit, LRO Wide Angle Camera colour mosaic,
               16k (lroc_color_poles_16k.tif), greyscale.

Reproducible: every source is fetched into the cache and checked against the
pins below (one SHA-256 over a layer's source tiles in order, one per file).
``--update-pins`` prints new pins instead of failing, for when NASA reissues.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import io
import json
import os
import shutil
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TILE = 512
WEBP_Q = 80
NAME = "zimi_almanac_hd"

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{layer}/default/{time}500m/{z}/{row}/{col}.{ext}"
# GIBS's 500 m matrix set: at level n, 512 px tiles from (-180, 90) in these counts,
# each pixel 288 / (2^n * 512) degrees (the set's last column and row run past the globe).
GIBS_RES = lambda n: 288.0 / (2**n * TILE)  # noqa: E731
GIBS_DIMS = {
    0: (2, 1),
    1: (3, 2),
    2: (5, 3),
    3: (10, 5),
    4: (20, 10),
    5: (40, 20),
    6: (80, 40),
    7: (160, 80),
}

LAYERS = {
    "earth/day": {
        "gibs": "BlueMarble_NextGeneration",
        "time": "",
        "ext": "jpeg",
        "src_level": 7,
        "max": 6,
        "mode": "RGB",
    },
    "earth/night": {
        "gibs": "VIIRS_Black_Marble",
        "time": "2016-01-01/",
        "ext": "png",
        "src_level": 6,
        "max": 5,
        "mode": "L",
    },
    # The planets: Solar System Scope's 8k maps (CC BY 4.0, credited in the view and the ZIM), to 8192 px.
    **{
        "planets/%s" % k: {"file": "https://www.solarsystemscope.com/textures/download/8k_%s.jpg" % f, "max": 3, "mode": "RGB"}
        for k, f in (("mercury", "mercury"), ("venus", "venus_surface"), ("mars", "mars"), ("jupiter", "jupiter"), ("saturn", "saturn"))
    },
    "moon/relief": {
        "file": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_64_uint.tif",
        "max": 4,
        "mode": "RGB",
        "derive": "normals",
        # Low sun reads a normal's every error as a slope: the lossy default left 16 px blocks across the maria.
        "quality": 95,
    },
    "moon/albedo": {
        "file": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_16k.tif",
        "max": 4,
        "mode": "L",
    },
}

# SHA-256 of each layer's sources: for GIBS, of every source tile's bytes in
# (row, column) order; for a file, of the file.
PINS = {
    "earth/day": "4c740966cc6fb41998af93fc6fa04d844ee2bcdf5e1d3e71c19c2db379d6288e",
    "earth/night": "584a4e5466a36ce443d622e353b2a7c53d39d3ee1f49e826ce6c058803abb394",
    "moon/albedo": "dbff4356479764d89f9fd7722140043eddbc2cafbad4dec5950858e2df77ac54",
    "planets/mercury": "5c8bd885ae3571c6ba2cd34b3446b9c6d767e314bf0ee8c1d5c147cadd388fc3",
    "planets/venus": "9bc21a50577ed8ac734cda91058724c7a741c19427aa276224ce349351432c5b",
    "planets/mars": "4cc52149924abc6ae507d63032f994e1d42a55cb82c09e002d1a567ff66c23ee",
    "planets/jupiter": "0bd844bf20822c4e3e80882b077859833c0dac44c7e4e1e0cd63d1b1b6d43085",
    "planets/saturn": "0d39a4a490c87c3edabe00a3881a29bb3418364178c79c534fe0986e97e09853",
    "moon/relief": "0f40bce8b42864deddb6943a38474879e691d5b20647aa5e54c2612b23106499",
}


def _fetch(url, path, tries=4):
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            tmp = path + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            return path
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))
    return path


def _sha_files(paths):
    h = hashlib.sha256()
    for p in paths:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()


def _check_pin(layer, digest, update):
    want = PINS.get(layer)
    if update or not want:
        print("pin %s %s" % (layer, digest))
        return
    if digest != want:
        sys.exit(
            "%s: sources changed (%s, pinned %s); rerun with --update-pins after checking them"
            % (layer, digest, want)
        )


def gibs_sources(layer, cache, update):
    spec = LAYERS[layer]
    n = spec["src_level"]
    cols, rows = GIBS_DIMS[n]
    folder = os.path.join(cache, "gibs", spec["gibs"], str(n))
    jobs = []
    for row in range(rows):
        for col in range(cols):
            url = GIBS.format(
                layer=spec["gibs"],
                time=spec["time"],
                z=n,
                row=row,
                col=col,
                ext=spec["ext"],
            )
            jobs.append(
                (url, os.path.join(folder, "%d_%d.%s" % (row, col, spec["ext"])))
            )
    with concurrent.futures.ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda j: _fetch(*j), jobs))
    _check_pin(layer, _sha_files([p for _, p in jobs]), update)
    return folder


class GibsMosaic:
    """Reads any window of a GIBS level as one picture, a source tile at a time."""

    def __init__(self, folder, level, ext, mode):
        self.folder, self.res, self.ext, self.mode = folder, GIBS_RES(level), ext, mode
        self.cols, self.rows = GIBS_DIMS[level]
        self._cache = {}

    def _tile(self, row, col):
        from PIL import Image

        key = (row, col)
        if key not in self._cache:
            if len(self._cache) > 64:
                self._cache.clear()
            im = Image.open(
                os.path.join(self.folder, "%d_%d.%s" % (row, col, self.ext))
            )
            self._cache[key] = im.convert(self.mode)
        return self._cache[key]

    def window(self, lon0, lat_top, span):
        from PIL import Image

        px = span / self.res
        x0, y0 = (lon0 + 180.0) / self.res, (90.0 - lat_top) / self.res
        c0, c1 = int(x0 // TILE), int((x0 + px - 1e-9) // TILE)
        r0, r1 = int(y0 // TILE), int((y0 + px - 1e-9) // TILE)
        canvas = Image.new(self.mode, ((c1 - c0 + 1) * TILE, (r1 - r0 + 1) * TILE))
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                canvas.paste(self._tile(r, c), ((c - c0) * TILE, (r - r0) * TILE))
        ox, oy = x0 - c0 * TILE, y0 - r0 * TILE
        return canvas.resize(
            (TILE, TILE), Image.LANCZOS, box=(ox, oy, ox + px, oy + px)
        )


class FileMosaic:
    """A whole-globe picture in plate carree (the Moon's map), windows cut from it."""

    def __init__(self, path, mode):
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = None
        self.im = Image.open(path).convert(mode)
        self.res = 360.0 / self.im.width

    def window(self, lon0, lat_top, span):
        from PIL import Image

        x0, y0, px = (
            (lon0 + 180.0) / self.res,
            (90.0 - lat_top) / self.res,
            span / self.res,
        )
        return self.im.resize(
            (TILE, TILE), Image.LANCZOS, box=(x0, y0, x0 + px, y0 + px)
        )


def tile_path(out, layer, z, x, y):
    return os.path.join(out, layer, str(z), str(x), "%d.webp" % y)


def _save(im, path, quality=WEBP_Q):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", quality=quality, method=6)


def _cut_row(args):
    kind, src, mode, layer, out, z, y, quality = args
    mos = GibsMosaic(*src, mode) if kind == "gibs" else FileMosaic(src, mode)
    span = 180.0 / 2**z
    for x in range(2 ** (z + 1)):
        _save(
            mos.window(-180.0 + x * span, 90.0 - y * span, span),
            tile_path(out, layer, z, x, y),
            quality,
        )
    return y


def _shrink_row(args):
    from PIL import Image

    layer, out, z, y, mode, quality = args
    for x in range(2 ** (z + 1)):
        quad = Image.new(mode, (2 * TILE, 2 * TILE))
        for dy in (0, 1):
            for dx in (0, 1):
                with Image.open(
                    tile_path(out, layer, z + 1, 2 * x + dx, 2 * y + dy)
                ) as child:
                    quad.paste(child.convert(mode), (dx * TILE, dy * TILE))
        _save(quad.resize((TILE, TILE), Image.LANCZOS), tile_path(out, layer, z, x, y), quality)
    return y


MOON_RADIUS_M = 1737400.0
HALF_METRE = 0.5  # the uint LOLA map's unit (offset 20,000 to stay positive: slopes do not see it)


RELIEF_SMOOTH_PX = 1.0  # LOLA's gridding leaves faint stripes along the tracks; a pixel's blur takes them, not the craters


def normals_map(dem_path, out_path, width):
    """An elevation map (plate carree) as a normal map ``width`` wide: per pixel, the unit normal's east and north
    components t as red and green, stored as 0.5 + 0.5 * sign(t) * sqrt(|t|) (0.5 is level; the shader squares it
    back), from centred differences over the sphere's true pixel sizes. Blue is unused (level)."""
    import numpy as np
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    if os.path.exists(out_path):
        return out_path
    src = Image.open(dem_path)
    dem = src.resize((width, width // 2), Image.BOX) if src.width != width else src
    from scipy.ndimage import gaussian_filter

    z = gaussian_filter(np.asarray(dem, dtype=np.float32) * HALF_METRE, RELIEF_SMOOTH_PX, mode="wrap")
    h, w = z.shape
    step = np.deg2rad(360.0 / w)
    lat = np.deg2rad(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    dx = (MOON_RADIUS_M * np.cos(lat) * step)[:, None]
    gx = (np.roll(z, -1, axis=1) - np.roll(z, 1, axis=1)) / (2 * dx)
    up, down = np.vstack([z[:1], z[:-1]]), np.vstack([z[1:], z[-1:]])
    gy = (up - down) / (2 * MOON_RADIUS_M * step)
    del z, up, down
    inv = 1.0 / np.sqrt(gx * gx + gy * gy + 1.0)
    rgb = np.empty((h, w, 3), dtype=np.uint8)
    for ch, g in ((0, gx), (1, gy)):
        t = -g * inv
        rgb[..., ch] = np.clip(np.rint((0.5 + 0.5 * np.sign(t) * np.sqrt(np.abs(t))) * 255), 0, 255)
    rgb[..., 2] = 128
    Image.fromarray(rgb, "RGB").save(out_path)
    return out_path


def build_layer(layer, cache, out, update, max_level=None, procs=None):
    spec = LAYERS[layer]
    top = spec["max"] if max_level is None else min(max_level, spec["max"])
    if "gibs" in spec:
        folder = gibs_sources(layer, cache, update)
        kind, src = "gibs", (folder, spec["src_level"], spec["ext"])
    else:
        path = _fetch(
            spec["file"], os.path.join(cache, "files", os.path.basename(spec["file"]))
        )
        _check_pin(layer, _sha_files([path]), update)
        if spec.get("derive") == "normals":
            path = normals_map(path, os.path.join(cache, "files", "moon-normals-v2-%d.png" % (TILE * 2 ** (top + 1))), TILE * 2 ** (top + 1))
        kind, src = "file", path
    # One process per row of the deepest level; a FileMosaic holds the whole map, so fewer of those at once.
    workers = procs or (os.cpu_count() or 4) if kind == "gibs" else 2
    q = spec.get("quality", WEBP_Q)
    with concurrent.futures.ProcessPoolExecutor(workers) as ex:
        if kind == "file":
            # The whole map is at hand: every level is cut from it, never from a level already compressed once.
            for z in range(top, -1, -1):
                list(ex.map(_cut_row, [(kind, src, spec["mode"], layer, out, z, y, q) for y in range(2**z)]))
        else:
            list(ex.map(_cut_row, [(kind, src, spec["mode"], layer, out, top, y, q) for y in range(2**top)]))
            for z in range(top - 1, -1, -1):
                list(ex.map(_shrink_row, [(layer, out, z, y, spec["mode"], q) for y in range(2**z)]))
    print("%s: levels 0-%d" % (layer, top))
    return top


INDEX = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Almanac HD</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>Almanac HD</h1>
<p>The Earth and the Moon as tile pyramids for Zimi's Almanac: the 3D view asks for the tiles in sight, at the detail the screen can show.</p>
<h2>Sources</h2>
<ul>
<li>Earth by day: NASA Blue Marble: Next Generation (Reto St&ouml;ckli, NASA Earth Observatory), served by NASA GIBS. Public domain.</li>
<li>Earth by night: NASA Black Marble 2016 (VIIRS), served by NASA GIBS. Public domain.</li>
<li>Moon: NASA Scientific Visualization Studio, CGI Moon Kit, from the Lunar Reconnaissance Orbiter Camera, and its elevation from the Lunar Orbiter Laser Altimeter. Public domain.</li>
<li>Mercury, Venus, Mars, Jupiter, Saturn: Solar System Scope (INOVE), CC BY 4.0, https://www.solarsystemscope.com/textures/.</li>
</ul></body></html>
"""

ZIMI_TXT = """Title: Almanac HD · Zimi
Description: Sharper Earth, Moon and planets for the Almanac's 3D view, as tiles
Language: eng
Creator: NASA
Publisher: Zimi
Tags: _category:education;astronomy;zimi;zimi:own;zimi:almanac-hd
Icon: icon.png
"""


MIMES = {".webp": "image/webp", ".json": "application/json", ".html": "text/html", ".png": "image/png"}


def pack_zim(stage, path):
    """The staged folder as one ZIM. Written here rather than by Zimi's folder capture: fifteen thousand tiles
    need no full-text index (the capture's indexing stalled libzim's writer at the end, under load), and the
    metadata is fixed. Every tile is an asset, never a front article: nothing here is read or searched."""
    import pathlib

    from libzim.writer import Creator

    from zimi.libzimcompat import add_illustration
    from zimi.zimwriter import make_asset_item, zim_static_item_class

    tmp = path + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)
    page = zim_static_item_class()
    with Creator(pathlib.Path(tmp)).config_indexing(False, "eng") as zc:
        zc.set_mainpath("index.html")
        for dirpath, dirnames, files in os.walk(stage):
            dirnames.sort()
            for fn in sorted(files):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, stage).replace(os.sep, "/")
                if rel in ("zimi.txt", "icon.png"):
                    continue
                with open(full, "rb") as f:
                    data = f.read()
                if rel == "index.html":
                    zc.add_item(page(rel, "Almanac HD", data))
                else:
                    zc.add_item(make_asset_item(rel, MIMES[os.path.splitext(fn)[1]], data))
        meta = dict(line.split(": ", 1) for line in ZIMI_TXT.strip().split("\n"))
        for key in ("Title", "Description", "Language", "Creator", "Publisher", "Tags"):
            zc.add_metadata(key, meta[key])
        zc.add_metadata("Name", NAME)
        zc.add_metadata("Date", datetime.date.today().isoformat())
        with open(os.path.join(stage, "icon.png"), "rb") as f:
            icon = f.read()
        from PIL import Image

        with Image.open(io.BytesIO(icon)) as im:
            small = io.BytesIO()
            im.convert("RGBA").resize((48, 48), Image.LANCZOS).save(small, "PNG")
        add_illustration(zc, 48, small.getvalue())
    os.replace(tmp, path)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(ROOT, "build", "almanac-hd-cache"))
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    ap.add_argument(
        "--max-earth",
        type=int,
        default=None,
        help="cap the Earth's deepest level (a quick build)",
    )
    ap.add_argument("--layers", default=",".join(LAYERS))
    ap.add_argument("--update-pins", action="store_true")
    ap.add_argument("--no-zim", action="store_true", help="stop at the staged folder")
    ap.add_argument("--keep-stage", action="store_true", help="add to the staged folder instead of starting it over")
    ap.add_argument("--tag", help="the release the file is attached to: writes zimi/assets/almanac-hd.json for it")
    a = ap.parse_args(argv)
    stage = os.path.join(a.cache, "stage")
    if os.path.isdir(stage) and not a.keep_stage:
        shutil.rmtree(stage)
    os.makedirs(stage, exist_ok=True)
    try:
        with open(os.path.join(stage, "hd.json")) as f:
            manifest = json.load(f) if a.keep_stage else None
    except (OSError, ValueError):
        manifest = None
    manifest = manifest or {"version": 1, "tile": TILE, "ext": "webp", "layers": {}}
    for layer in a.layers.split(","):
        cap = a.max_earth if layer.startswith("earth/") else None
        manifest["layers"][layer] = {
            "max": build_layer(layer, a.cache, stage, a.update_pins, cap)
        }
    with open(os.path.join(stage, "hd.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    with open(os.path.join(stage, "index.html"), "w") as f:
        f.write(INDEX)
    with open(os.path.join(stage, "zimi.txt"), "w") as f:
        f.write(ZIMI_TXT)
    shutil.copy(
        os.path.join(ROOT, "zimi", "builtin", "almanac", "icon.png"),
        os.path.join(stage, "icon.png"),
    )
    if a.no_zim:
        print("staged", stage)
        return 0
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(
        a.out, "%s_%s.zim" % (NAME, datetime.date.today().strftime("%Y-%m"))
    )
    pack_zim(stage, path)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    if a.tag:
        # What almanachd.py offers and fetches: committed with the release that carries the file.
        asset = {"file": os.path.basename(path), "size": os.path.getsize(path), "sha256": _sha_files([path]), "tag": a.tag}
        with open(os.path.join(ROOT, "zimi", "assets", "almanac-hd.json"), "w") as f:
            json.dump(asset, f, indent=2)
            f.write("\n")
        print("wrote zimi/assets/almanac-hd.json for", a.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
