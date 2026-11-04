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
    "moon/albedo": {
        "file": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_16k.tif",
        "max": 4,
        "mode": "L",
    },
}

# SHA-256 of each layer's sources: for GIBS, of every source tile's bytes in
# (row, column) order; for a file, of the file.
PINS = {
    "earth/day": "",
    "earth/night": "",
    "moon/albedo": "dbff4356479764d89f9fd7722140043eddbc2cafbad4dec5950858e2df77ac54",
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


def _save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", quality=WEBP_Q, method=6)


def _cut_row(args):
    kind, src, mode, layer, out, z, y = args
    mos = GibsMosaic(*src, mode) if kind == "gibs" else FileMosaic(src, mode)
    span = 180.0 / 2**z
    for x in range(2 ** (z + 1)):
        _save(
            mos.window(-180.0 + x * span, 90.0 - y * span, span),
            tile_path(out, layer, z, x, y),
        )
    return y


def _shrink_row(args):
    from PIL import Image

    layer, out, z, y, mode = args
    for x in range(2 ** (z + 1)):
        quad = Image.new(mode, (2 * TILE, 2 * TILE))
        for dy in (0, 1):
            for dx in (0, 1):
                with Image.open(
                    tile_path(out, layer, z + 1, 2 * x + dx, 2 * y + dy)
                ) as child:
                    quad.paste(child.convert(mode), (dx * TILE, dy * TILE))
        _save(quad.resize((TILE, TILE), Image.LANCZOS), tile_path(out, layer, z, x, y))
    return y


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
        kind, src = "file", path
    # One process per row of the deepest level; a FileMosaic holds the whole map, so fewer of those at once.
    workers = procs or (os.cpu_count() or 4) if kind == "gibs" else 2
    with concurrent.futures.ProcessPoolExecutor(workers) as ex:
        list(
            ex.map(
                _cut_row,
                [(kind, src, spec["mode"], layer, out, top, y) for y in range(2**top)],
            )
        )
        for z in range(top - 1, -1, -1):
            list(
                ex.map(
                    _shrink_row, [(layer, out, z, y, spec["mode"]) for y in range(2**z)]
                )
            )
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
<li>Moon: NASA Scientific Visualization Studio, CGI Moon Kit, from the Lunar Reconnaissance Orbiter Camera. Public domain.</li>
</ul></body></html>
"""

ZIMI_TXT = """Title: Almanac HD · Zimi
Description: Sharper Earth and Moon for the Almanac's 3D view: NASA imagery as tiles
Language: eng
Creator: NASA
Publisher: Zimi
Tags: _category:education;astronomy;zimi;zimi:own;zimi:almanac-hd
Icon: icon.png
"""


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
    a = ap.parse_args(argv)
    stage = os.path.join(a.cache, "stage")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    manifest = {"version": 1, "tile": TILE, "ext": "webp", "layers": {}}
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
    from zimi import creator

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(
        a.out, "%s_%s.zim" % (NAME, datetime.date.today().strftime("%Y-%m"))
    )
    creator.create_folder_zim(stage, out_path=path, register=False)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
