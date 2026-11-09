"""Build Almanac HD: every world in the 3D view as a tile pyramid, one ZIM.

    python scripts/build_almanac_hd.py [--cache DIR] [--out DIR] [--max-earth N] [--update-pins]
    python scripts/build_almanac_hd.py --small-maps DIR --layers planets/phobos,...

The Almanac draws each world from one small map, fetched with the page. Almanac
HD is the sharp version: each body's map cut into 512 px tiles, level by level,
so the 3D view (almanac-earth.js) asks only for the tiles in view at the detail
the screen can show. It is a ZIM of its own, built here and attached to a
release (never committed: hundreds of MB). It is the tile source: every
release's HD flavour of the Almanac (scripts/build_almanac_maxi.py, the file
Zimi downloads when someone opening the Almanac says yes) is built from it,
pinned in zimi/assets/almanac-tiles.json. Run this only for a new one (NASA
reissues, a new body). The sources are large (the Mars colour mosaic alone is
12.7 GB and is held whole to reduce it): it wants about 32 GB of memory and
60 GB of disk, more than a standard GitHub runner has, so it is built on a big
machine and the file attached by hand (.github/workflows/almanac-hd.yml is the
recipe for a runner that has them).

Tiling: plate carree, the same as the maps already shipped. Level z holds
2^(z+1) columns by 2^z rows of square tiles, 180 / 2^z degrees on a side;
column 0 starts at longitude -180, row 0 at latitude +90. A tile is
``<body>/<layer>/<z>/<x>/<y>.webp``. ``hd.json`` at the root lists each layer's
deepest level, so a client never asks for a tile that is not there.

Sources (all public domain except Jupiter and Saturn, credited in the ZIM's
index page and in zimi/static/earth/SOURCES.txt). Each is cut at the mosaic's
own pixel size, or at what a phone can use where the mosaic is far finer:
  earth/day    NASA Blue Marble: Next Generation, through NASA GIBS (500 m set,
               level 7, 0.0044 deg a pixel). Deepest level 6: 610 m a pixel,
               the finest the 500 m mosaic holds without inventing pixels.
  earth/night  NASA Black Marble 2016 (VIIRS), through NASA GIBS, greyscale,
               at the same level.
  moon/relief  NASA SVS CGI Moon Kit, LOLA elevation at 64 pixels a degree
               (ldem_64_uint.tif, half-metres), as surface normals: east and
               north tilt in red and green, square-root companded (a mare's
               tenth-of-a-degree slopes would band at 8 bits under a low Sun),
               so the Moon's own shader lights every crater wall and ridge
               from the Sun of the moment.
  moon/albedo  The LRO Wide Angle Camera global mosaic at 100 m (USGS
               Astrogeology), greyscale, cut to 166 m.
  planets/*    USGS Astrogeology's global mosaics (planetarymaps.usgs.gov):
               Mercury (MESSENGER), Venus (Magellan), Mars (Viking colour),
               the Galilean moons, Titan, Enceladus, Tethys, Dione, Rhea and
               Iapetus (Cassini), Triton (Voyager), Pluto and Charon (New
               Horizons), Vesta and Ceres (Dawn; Ceres as shaded relief of its
               elevation model, there being no albedo mosaic in the public
               domain), Phobos (Viking). Jupiter and Saturn: Solar System Scope.

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

USGS = "https://planetarymaps.usgs.gov/mosaic/%s"
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
        "src_level": 7,
        "max": 6,
        "mode": "L",
    },
    # Jupiter and Saturn at 8192 px: Solar System Scope's 8k maps (CC BY 4.0, credited in the view and the ZIM): a gas
    # giant has no surface mosaic in the public domain.
    **{
        "planets/%s"
        % k: {
            "file": "https://www.solarsystemscope.com/textures/download/8k_%s.jpg" % f,
            "max": 3,
            "mode": "RGB",
        }
        for k, f in (("jupiter", "jupiter"), ("saturn", "saturn"))
    },
    # Every other world from its public-domain global mosaic (NASA/USGS, planetarymaps.usgs.gov), cut to the
    # mosaic's own pixel size where it is near (a level past it would invent pixels), or to what a phone can use
    # where it is far finer ("prescale": the source is first reduced once to the deepest level's width).
    #   roll    the file runs 0-360 east, the pyramid -180..180
    #   tint    a greyscale mosaic's colour comes from the small colour map shipped with the view (zimi/static/earth/),
    #           so the sharp tiles keep the world's colour
    #   derive  "shade": an elevation model drawn as shaded relief
    **{
        "planets/%s" % k: dict(spec, file=USGS % f, mode=mode)
        for k, f, mode, spec in (
            ("venus", "Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif", "RGB", {"max": 3}),
            ("mars", "Mars_Viking_MDIM21_ClrMosaic_global_232m.tif", "RGB", {"max": 5, "prescale": True}),
            ("mercury", "Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m.tif", "L", {"max": 5, "prescale": True, "tint": "mercury-v1.webp"}),
            ("io", "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif", "RGB", {"max": 3}),
            ("europa", "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif", "L", {"max": 4, "roll": True}),
            ("ganymede", "Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif", "L", {"max": 4, "roll": True, "tint": "ganymede-v1.webp"}),
            ("callisto", "Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", "L", {"max": 4, "roll": True}),
            ("titan", "Titan_ISS_P19658_Mosaic_Global_4km.tif", "L", {"max": 2, "roll": True}),
            ("pluto", "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", "L", {"max": 4, "roll": True, "tint": "pluto-v1.webp"}),
            ("charon", "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", "L", {"max": 4}),
            ("triton", "Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif", "RGB", {"max": 4}),
            ("enceladus", "Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif", "L", {"max": 4}),
            ("tethys", "Tethys_Cassini_mosaic_global_293m.tif", "L", {"max": 3}),
            ("dione", "Dione_Cassini_Voyager_mosaic_global_154m.tif", "L", {"max": 4}),
            ("rhea", "Rhea_Cassini_Voyager_mosaic_global_417m.tif", "L", {"max": 3}),
            ("iapetus", "Iapetus_Cassini_Voyager_mosaic_global_783m.tif", "L", {"max": 3}),
            ("vesta", "Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif", "L", {"max": 4}),
            ("phobos", "Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif", "L", {"max": 3}),
            ("ceres", "Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif", "L", {"max": 4, "derive": "shade", "radius_m": 470000}),
        )
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
        # The LRO Wide Angle Camera's global mosaic at 100 m a pixel (NASA/GSFC/Arizona State University, through USGS),
        # cut to 166 m: a pixel of the 3D view on a phone at the Moon's closest approach.
        "file": USGS % "Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif",
        "max": 6,
        "mode": "L",
        "prescale": True,
    },
}

# SHA-256 of each layer's sources: for GIBS, of every source tile's bytes in
# (row, column) order; for a file, of the file.
PINS = {
    "earth/day": "4c740966cc6fb41998af93fc6fa04d844ee2bcdf5e1d3e71c19c2db379d6288e",
    "earth/night": "08afd4244300ef272b5f93b4bc04a41a41d83159f5919df0c2fd762ed4763eb0",
    "moon/albedo": "87159ead1888ae31bb647e957ec60943022b707ec804cb5353a304575936fd55",
    "planets/mercury": "d4c0880c39d062994a6f02c0462ec6c87f60fdcc504546915e076e2cd472b1da",
    "planets/io": "135f88cb645bfdb4e045b380971ab2ba14e230590c96c9c86cfe7310fda881ac",
    "planets/europa": "a323f0c9ccb47d5af9902ea8297fe81f9a9708795645b80801f103c3f7c9a624",
    "planets/ganymede": "c2c8d9506b8cf8f7a0a90d823d9052e91c8d9885cf7267fdce8de8216f4df888",
    "planets/callisto": "e1f0bd2e0e05de605d067d6b5f5ededddaf31ca6c064562a1ca770f15a7dbaa3",
    "planets/titan": "ca0fe5f6f9bdba1b6d03245969a42336a010ddc17d636e5e06fffa939d10ca83",
    "planets/pluto": "592b7fb0f88cafa0bedf9f33bb71e983952a250ee8577edf2abfe814b473356b",
    "planets/venus": "6bfcd1ccaa79bad8b6d6943a86b6c77b65c7cf48a6ecbf900e429e334f584f43",
    "planets/mars": "554f1170998b4cd00359defa48600307e52c49f921c282d842361ad45082aa31",
    "planets/jupiter": "0bd844bf20822c4e3e80882b077859833c0dac44c7e4e1e0cd63d1b1b6d43085",
    "planets/saturn": "0d39a4a490c87c3edabe00a3881a29bb3418364178c79c534fe0986e97e09853",
    "moon/relief": "0f40bce8b42864deddb6943a38474879e691d5b20647aa5e54c2612b23106499",
    "planets/charon": "4a874809e0a33a851cd026b8e4647f5875ed15807e677d413812367509564b00",
    "planets/triton": "f20ed332e85df469725629b81d3a73ad026897fe561ec59d6245d249a09507db",
    "planets/enceladus": "a15d944acf7da25e89f8f1ece6694632521980e77af024db7746cb33d05fb04b",
    "planets/tethys": "40723c3ebfaaa52a657827b37309bc84234811db1cf26a21d086e26aba2b3640",
    "planets/dione": "5c5d796c02e3c99fde5dd034e01dd1f25905699a4885843aed445ded955e08b5",
    "planets/rhea": "ce537c3c93670a0d4ea5a64b99bffb76ff308727eb3eabeee0a38cf9f6f1abc7",
    "planets/iapetus": "eb8acdbed3af495102b6ec6d3efce1f03dc6bc39bb43323c23231ce590494d6e",
    "planets/vesta": "e7a5dab2924ed590947230e70b11fd42e61e6582f94c01180ddb64b3a9f86ff4",
    "planets/phobos": "d7934d5b209e5f31ed26297e1e85a4713d8d0aa2906111ffe4b3d60d02ae0ccb",
    "planets/ceres": "81da73151b4353c03d7ca18fa85972d1cb9c8530b3c5496df9ade7cb75af1915",
}


def _fetch(url, path, tries=4):
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for i in range(tries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Zimi-build/1.0 (https://github.com/epheterson/Zimi)"
                },
            )  # Wikimedia refuses none
            with urllib.request.urlopen(req, timeout=120) as r:
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


CHROMA_FLOOR = 8.0  # a base-map pixel darker than this has no colour to lend (an unmapped pole)
CHROMA_MAX = 2.0
LUMA = (0.299, 0.587, 0.114)
EARTH_DIR = os.path.join(ROOT, "zimi", "static", "earth")


class FileMosaic:
    """A whole-globe picture in plate carree (the Moon's map), windows cut from it. ``roll``: the picture runs 0-360
    degrees east, rolled here to -180..180. ``tint``: a small colour map (-180..180) whose colours, not brightness,
    are laid on a greyscale picture's windows."""

    def __init__(self, path, mode, roll=False, tint=None):
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = None
        im = Image.open(path).convert(mode)
        if roll:
            half = im.width // 2
            rolled = Image.new(im.mode, im.size)
            rolled.paste(im.crop((half, 0, im.width, im.height)), (0, 0))
            rolled.paste(im.crop((0, 0, half, im.height)), (im.width - half, 0))
            im = rolled
        self.im = im
        self.res = 360.0 / self.im.width
        self.tint = Image.open(tint).convert("RGB") if tint else None

    def _chroma(self, lon0, lat_top, span):
        """The tint map's colour over a window as ratios to its own brightness (1 where it has none), a tile wide."""
        import numpy as np
        from PIL import Image

        res = 360.0 / self.tint.width
        x0, y0, px = (lon0 + 180.0) / res, (90.0 - lat_top) / res, span / res
        box = (x0, y0, x0 + px, y0 + px)
        rgb = np.asarray(self.tint.resize((TILE, TILE), Image.BICUBIC, box=box), dtype=np.float32)
        lum = (rgb @ np.array(LUMA, dtype=np.float32))[..., None]
        ratio = np.where(lum > CHROMA_FLOOR, rgb / np.maximum(lum, 1.0), 1.0)
        return np.clip(ratio, 0.0, CHROMA_MAX)

    def whole(self, width):
        """The whole globe ``width`` x ``width / 2``: the small map shipped with the view (zimi/static/earth/)."""
        import numpy as np
        from PIL import Image

        size = (width, width // 2)
        small = self.im.resize(size, Image.LANCZOS)
        if self.tint is None:
            return small
        rgb = np.asarray(self.tint.resize(size, Image.BICUBIC), dtype=np.float32)
        lum = (rgb @ np.array(LUMA, dtype=np.float32))[..., None]
        ratio = np.clip(np.where(lum > CHROMA_FLOOR, rgb / np.maximum(lum, 1.0), 1.0), 0.0, CHROMA_MAX)
        grey = np.asarray(small, dtype=np.float32)[..., None]
        return Image.fromarray(np.clip(grey * ratio, 0, 255).astype(np.uint8))

    def window(self, lon0, lat_top, span):
        from PIL import Image

        x0, y0, px = (lon0 + 180.0) / self.res, (90.0 - lat_top) / self.res, span / self.res
        tile = self.im.resize((TILE, TILE), Image.LANCZOS, box=(x0, y0, x0 + px, y0 + px))
        if self.tint is None:
            return tile
        import numpy as np

        grey = np.asarray(tile, dtype=np.float32)[..., None]
        out = np.clip(grey * self._chroma(lon0, lat_top, span), 0, 255).astype(np.uint8)
        return Image.fromarray(out)


def tile_path(out, layer, z, x, y):
    return os.path.join(out, layer, str(z), str(x), "%d.webp" % y)


def _save(im, path, quality=WEBP_Q):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", quality=quality, method=6)


def _cut_row(args):
    kind, src, mode, layer, out, z, y, quality = args
    mos = (
        GibsMosaic(*src, mode) if kind == "gibs" else FileMosaic(src[0], mode, *src[1:])
    )
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
        _save(
            quad.resize((TILE, TILE), Image.LANCZOS),
            tile_path(out, layer, z, x, y),
            quality,
        )
    return y


MOON_RADIUS_M = 1737400.0
HALF_METRE = 0.5  # the uint LOLA map's unit (offset 20,000 to stay positive: slopes do not see it)


RELIEF_SMOOTH_MODE = ("nearest", "wrap")  # (latitude, longitude)
RELIEF_SMOOTH_PX = 1.0  # LOLA's gridding leaves faint stripes along the tracks; a pixel's blur takes them, not the craters


def normals_map(dem_path, out_path, width):
    """An elevation map (plate carree) as a normal map ``width`` wide: per pixel, the unit normal's east and north
    components t as red and green, stored as 0.5 + 0.5 * sign(t) * sqrt(|t|) (0.5 is level; the shader squares it
    back), from centred differences over the sphere's true pixel sizes. Blue is unused (level).
    """
    import numpy as np
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    if os.path.exists(out_path):
        return out_path
    src = Image.open(dem_path)
    dem = src.resize((width, width // 2), Image.BOX) if src.width != width else src
    from scipy.ndimage import gaussian_filter

    # Longitude wraps round the globe; latitude ends at the poles and must not blend one into the other.
    z = gaussian_filter(
        np.asarray(dem, dtype=np.float32) * HALF_METRE,
        RELIEF_SMOOTH_PX,
        mode=RELIEF_SMOOTH_MODE,
    )
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
        rgb[..., ch] = np.clip(
            np.rint((0.5 + 0.5 * np.sign(t) * np.sqrt(np.abs(t))) * 255), 0, 255
        )
    rgb[..., 2] = 128
    Image.fromarray(rgb).save(out_path)
    return out_path


def prescaled(path, mode, width, out_path):
    """A mosaic far finer than the pyramid's deepest level, reduced once to its width (a box filter, the honest
    average): otherwise every one of thousands of tiles would reach into a multi-gigabyte picture."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    if os.path.exists(out_path):
        return out_path
    im = Image.open(path)
    if im.mode != mode:  # a copy of a 12 GB picture is one too many
        im = im.convert(mode)
    reduced = im.resize((width, width // 2), Image.BOX)
    del im
    tmp = out_path + ".part.png"
    reduced.save(tmp, compress_level=1)
    os.replace(tmp, out_path)
    return out_path


SHADE_AZIMUTH_DEG, SHADE_ALTITUDE_DEG = 315.0, 45.0  # the light, from the north-west and half way up
SHADE_BASE, SHADE_GAIN = 0.45, 0.8                   # a flat place's grey, and how much a slope moves it
DEM_NODATA = -32768


def shaded_map(dem_path, out_path, width, radius_m):
    """An elevation model (int16 metres, plate carree) as gentle shaded relief ``width`` wide, for a world with no
    albedo mosaic in the public domain: grey where flat, lighter and darker on slopes that face toward and away from
    the light. Slopes come from the true pixel sizes on the sphere."""
    import numpy as np
    import tifffile
    from PIL import Image

    if os.path.exists(out_path):
        return out_path
    dem = tifffile.imread(dem_path).astype(np.float32)
    dem[dem == DEM_NODATA] = np.nan
    mean = np.nanmean(dem)
    dem = np.where(np.isnan(dem), mean, dem)
    z = np.asarray(Image.fromarray(dem).resize((width, width // 2), Image.BOX), dtype=np.float32)
    h, w = z.shape
    step = np.deg2rad(360.0 / w)
    lat = np.deg2rad(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    dx = np.maximum(radius_m * np.cos(lat) * step, 1.0)[:, None]
    gx = (np.roll(z, -1, axis=1) - np.roll(z, 1, axis=1)) / (2 * dx)
    up, down = np.vstack([z[:1], z[:-1]]), np.vstack([z[1:], z[-1:]])
    gy = (up - down) / (2 * radius_m * step)
    az, alt = np.deg2rad(SHADE_AZIMUTH_DEG), np.deg2rad(SHADE_ALTITUDE_DEG)
    light = (np.cos(alt) * np.sin(az), np.cos(alt) * np.cos(az), np.sin(alt))
    shade = (-gx * light[0] - gy * light[1] + light[2]) / np.sqrt(gx * gx + gy * gy + 1.0)
    out = np.clip((SHADE_BASE + SHADE_GAIN * (shade - np.sin(alt))) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(out).save(out_path)
    return out_path


def file_source(layer, spec, cache, top, update):
    """A file layer's picture ready to cut: fetched, checked against its pin, and derived or reduced where the layer
    says so. Returns (path, roll, tint map or None)."""
    path = _fetch(
        spec["file"], os.path.join(cache, "files", os.path.basename(spec["file"]))
    )
    source_sha = _sha_files([path])
    _check_pin(layer, source_sha, update)
    if spec.get("derive") == "normals":
        # Keyed by the elevation map's digest too: a new DEM (--update-pins) must not meet the last one's normals.
        width = TILE * 2 ** (top + 1)
        path = normals_map(
            path,
            os.path.join(
                cache,
                "files",
                "moon-normals-v2-%d-%s.png" % (width, source_sha[:12]),
            ),
            width,
        )
    if spec.get("derive") == "shade":
        width = TILE * 2 ** (top + 1)
        path = shaded_map(path, os.path.join(cache, "files", "%s-shade-%d-%s.png" % (os.path.basename(layer), width, source_sha[:12])), width, spec["radius_m"])
    elif spec.get("prescale"):
        width = TILE * 2 ** (top + 1)
        path = prescaled(path, spec["mode"], width, os.path.join(cache, "files", "%s-%d-%s.png" % (os.path.basename(layer), width, source_sha[:12])))
    tint = spec.get("tint")
    return path, spec.get("roll", False), os.path.join(EARTH_DIR, tint) if tint else None


def build_layer(layer, cache, out, update, max_level=None, procs=None):
    spec = LAYERS[layer]
    top = spec["max"] if max_level is None else min(max_level, spec["max"])
    if "gibs" in spec:
        folder = gibs_sources(layer, cache, update)
        kind, src = "gibs", (folder, spec["src_level"], spec["ext"])
    else:
        kind, src = "file", file_source(layer, spec, cache, top, update)
    # One process per row of the deepest level; a FileMosaic holds the whole map, so fewer of those at once.
    workers = procs or (os.cpu_count() or 4) if kind == "gibs" else 2
    q = spec.get("quality", WEBP_Q)
    with concurrent.futures.ProcessPoolExecutor(workers) as ex:
        if kind == "file":
            # The whole map is at hand: every level is cut from it, never from a level already compressed once.
            for z in range(top, -1, -1):
                list(
                    ex.map(
                        _cut_row,
                        [
                            (kind, src, spec["mode"], layer, out, z, y, q)
                            for y in range(2**z)
                        ],
                    )
                )
        else:
            list(
                ex.map(
                    _cut_row,
                    [
                        (kind, src, spec["mode"], layer, out, top, y, q)
                        for y in range(2**top)
                    ],
                )
            )
            for z in range(top - 1, -1, -1):
                list(
                    ex.map(
                        _shrink_row,
                        [(layer, out, z, y, spec["mode"], q) for y in range(2**z)],
                    )
                )
    print("%s: levels 0-%d" % (layer, top))
    return top


INDEX = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Almanac HD</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>Almanac HD</h1>
<p>The Earth, the Moon and the planets and moons as tile pyramids for Zimi's Almanac: the 3D view asks for the tiles in sight, at the detail the screen can show.</p>
<h2>Sources</h2>
<ul>
<li>Earth by day: NASA Blue Marble: Next Generation (Reto St&ouml;ckli, NASA Earth Observatory), served by NASA GIBS. Public domain.</li>
<li>Earth by night: NASA Black Marble 2016 (VIIRS), served by NASA GIBS. Public domain.</li>
<li>Moon: the Lunar Reconnaissance Orbiter Camera's Wide Angle Camera global mosaic (NASA/GSFC/Arizona State University, through USGS Astrogeology), and its elevation from the Lunar Orbiter Laser Altimeter (NASA Scientific Visualization Studio, CGI Moon Kit). Public domain.</li>
<li>The Apollo landing sites: LRO Narrow Angle Camera mosaics (NASA/GSFC/Arizona State University), through NASA Moon Trek. Public domain.</li>
<li>Mercury: MESSENGER MDIS global basemap (NASA/JHUAPL/Carnegie Institution, through USGS Astrogeology), its brightness; the colour is the small map's. Public domain.</li>
<li>Venus: Magellan global mosaic (NASA/JPL, through USGS Astrogeology). Public domain.</li>
<li>Mars: Viking MDIM 2.1 colour mosaic (NASA/JPL/USGS). Public domain.</li>
<li>Io, Europa, Ganymede, Callisto: Galileo and Voyager global mosaics (NASA/JPL/USGS Astrogeology). Public domain.</li>
<li>Titan, Enceladus, Tethys, Dione, Rhea, Iapetus: Cassini ISS and Voyager global mosaics (NASA/JPL/Space Science Institute/DLR, through USGS Astrogeology). Public domain.</li>
<li>Triton: Voyager 2 global colour mosaic (NASA/JPL/USGS Astrogeology). Public domain.</li>
<li>Pluto, Charon: New Horizons global mosaics (NASA/JHUAPL/SwRI, through USGS Astrogeology); Pluto's colour is the small map's. Public domain.</li>
<li>Vesta: Dawn Framing Camera global mosaic (NASA/JPL-Caltech/UCLA/MPS/DLR/IDA, through USGS Astrogeology). Public domain.</li>
<li>Ceres: shaded relief of the Dawn HAMO elevation model (NASA/JPL-Caltech/UCLA/MPS/DLR/IDA, DLR, through USGS Astrogeology). Public domain.</li>
<li>Phobos: Viking mosaic, DLR control (NASA/JPL/DLR, through USGS Astrogeology). Public domain.</li>
<li>Jupiter, Saturn: Solar System Scope (INOVE), CC BY 4.0, https://www.solarsystemscope.com/textures/.</li>
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


# The Apollo sites at the Narrow Angle Camera's half a metre: LRO NAC mosaics (NASA/GSFC/Arizona State University,
# public domain) through NASA's Moon Trek tile service, cut into this pyramid's tiles round each landing, deeper than
# the global map goes (an "insert": levels past moon/albedo's max, only there). (name, Trek layer, lat, lon, deepest
# level here). At the deepest, the descent stages and their tracks show.
TREK = "https://trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/default/default028mm/{z}/{row}/{col}.png"
INSERTS = [
    ("apollo11", "A11_60x60km.eq", 0.67408, 23.47297, 14),
    ("apollo12", "LRO_NAC_Apollo12_Mosaic_p", -3.01239, -23.42157, 14),
    ("apollo15", "LRO_NAC_Apollo15_Mosaic_p", 26.13222, 3.63386, 14),
    ("apollo16", "LRO_NAC_Apollo16_Mosaic_p", -8.97301, 15.50019, 13),
    ("apollo17", "M129086118.nd.gcs", 20.19080, 30.77168, 14),
]
INSERT_HALF = 2  # tiles either side of the site at each level: a 5 x 5 patch, about 2.5 km across at the deepest


def _trek_path(cache, layer, z, row, col):
    return os.path.join(cache, "trek", layer, str(z), "%d_%d.png" % (row, col))


def _trek_get(job):
    """Fetch one Trek tile into the cache; a tile past the mosaic's edge is missing, and a marker says so."""
    cache, layer, z, row, col = job
    path = _trek_path(cache, layer, z, row, col)
    if os.path.exists(path) or os.path.exists(path + ".miss"):
        return
    try:
        _fetch(TREK.format(layer=layer, z=z, row=row, col=col), path, tries=2)
    except OSError:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path + ".miss", "w").close()


def _trek_tile(cache, layer, z, row, col):
    from PIL import Image

    path = _trek_path(cache, layer, z, row, col)
    try:
        return Image.open(path).convert("LA") if os.path.exists(path) else None
    except OSError:
        return None


def _insert_extents(first):
    """Every site's patch at every level: (site, Trek layer, lat, lon, z, x0, x1, y0, y1)."""
    for name, layer, lat, lon, deepest in INSERTS:
        for z in range(first, deepest + 1):
            span = 180.0 / 2**z
            cx, cy = int((lon + 180) // span), int((90 - lat) // span)
            yield name, layer, lat, lon, z, cx - INSERT_HALF, cx + INSERT_HALF, cy - INSERT_HALF, cy + INSERT_HALF


def _insert_tile(cache, stage, layer, z, x, y, base_level):
    """One of this pyramid's tiles (z, x, y) at a site: the NAC mosaic's four Trek tiles over it, brought to the
    global map's brightness, laid on the global map's tile upsampled from base_level where the mosaic has no data.
    """
    from PIL import Image

    up = z - base_level
    with Image.open(
        tile_path(stage, "moon/albedo", base_level, x >> up, y >> up)
    ) as parent:
        n = 2**up
        cell = TILE / n
        ox, oy = (x % n) * cell, (y % n) * cell
        base = parent.convert("L").resize(
            (TILE, TILE), Image.BICUBIC, box=(ox, oy, ox + cell, oy + cell)
        )
    nac = Image.new("LA", (TILE, TILE))
    for dy in (0, 1):
        for dx in (0, 1):
            t = _trek_tile(cache, layer, z + 1, 2 * y + dy, 2 * x + dx)
            if t is not None:
                nac.paste(t, (dx * 256, dy * 256))
    return base, nac


def build_inserts(cache, stage, base_level):
    """Every site's tiles from the first level past the global map's (base_level + 1) to its deepest; returns the
    manifest's list of what exists."""
    from PIL import Image, ImageStat

    jobs = [
        (cache, layer, z + 1, 2 * y + dy, 2 * x + dx)
        for _n, layer, _la, _lo, z, x0, x1, y0, y1 in _insert_extents(base_level + 1)
        for y in range(y0, y1 + 1)
        for x in range(x0, x1 + 1)
        for dy in (0, 1)
        for dx in (0, 1)
    ]
    with concurrent.futures.ThreadPoolExecutor(12) as ex:
        list(ex.map(_trek_get, jobs))
    out, gains = [], {}
    for name, layer, lat, lon, z, x0, x1, y0, y1 in _insert_extents(base_level + 1):
        gain = gains.get(name)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                base, nac = _insert_tile(cache, stage, layer, z, x, y, base_level)
                lum, alpha = nac.split()
                if gain is None and ImageStat.Stat(alpha).mean[0] > 128:
                    # The mosaic's brightness against the global map's, once, where both are whole.
                    m_nac, m_base = (
                        ImageStat.Stat(lum, alpha).median[0],
                        ImageStat.Stat(base, alpha).median[0],
                    )
                    gain = gains[name] = m_base / max(1.0, m_nac)
                lum = lum.point(lambda v, g=(gain or 1.0): min(255, int(v * g + 0.5)))
                _save(
                    Image.composite(lum, base, alpha),
                    tile_path(stage, "moon/albedo", z, x, y),
                    INSERT_Q,
                )
        out.append(
            {
                "site": name,
                "lat": lat,
                "lon": lon,
                "z": z,
                "x0": x0,
                "x1": x1,
                "y0": y0,
                "y1": y1,
            }
        )
    print("inserts: %d patches" % len(out))
    return out


INSERT_Q = 85
MIMES = {
    ".webp": "image/webp",
    ".json": "application/json",
    ".html": "text/html",
    ".png": "image/png",
}


def pack_zim(stage, path):
    """The staged folder as one ZIM. Written here rather than by Zimi's folder capture: fifteen thousand tiles
    need no full-text index (the capture's indexing stalled libzim's writer at the end, under load), and the
    metadata is fixed. Every tile is an asset, never a front article: nothing here is read or searched.
    """
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
                    zc.add_item(
                        make_asset_item(rel, MIMES[os.path.splitext(fn)[1]], data)
                    )
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


SMALL_MAP_WIDTH = 1024
SMALL_MAP_Q = 80


def write_small_maps(layers, cache, out_dir, update):
    """The small map each world is drawn from before its tiles (and without Almanac HD): the same picture, rolled and
    tinted the same way, ``planets/<key>`` as ``<out_dir>/<key>-v1.webp``."""
    os.makedirs(out_dir, exist_ok=True)
    for layer in layers:
        spec = LAYERS[layer]
        if "file" not in spec or not layer.startswith("planets/"):
            continue
        path, roll, tint = file_source(layer, spec, cache, spec["max"], update)
        mos = FileMosaic(path, spec["mode"], roll, tint)
        dest = os.path.join(out_dir, "%s-v1.webp" % os.path.basename(layer))
        im = mos.whole(SMALL_MAP_WIDTH)
        im.save(dest, "WEBP", quality=SMALL_MAP_Q, method=6)
        print("small map", dest, im.size, os.path.getsize(dest))
    return 0


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
    ap.add_argument(
        "--keep-stage",
        action="store_true",
        help="add to the staged folder instead of starting it over",
    )
    ap.add_argument(
        "--inserts",
        action="store_true",
        default=True,
        help="the Apollo sites' NAC inserts (on unless --no-inserts)",
    )
    ap.add_argument("--no-inserts", dest="inserts", action="store_false")
    ap.add_argument("--small-maps", metavar="DIR", help="instead of tiles, write each layer's small map (1024 x 512 WebP) there")
    ap.add_argument(
        "--tag",
        help="the release the file is attached to: writes zimi/assets/almanac-tiles.json for it",
    )
    a = ap.parse_args(argv)
    if a.small_maps:
        return write_small_maps([x for x in a.layers.split(",") if x], a.cache, a.small_maps, a.update_pins)
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
    for layer in [x for x in a.layers.split(",") if x]:
        cap = a.max_earth if layer.startswith("earth/") else None
        manifest["layers"][layer] = {
            "max": build_layer(layer, a.cache, stage, a.update_pins, cap)
        }
    albedo = manifest["layers"].get("moon/albedo")
    if (
        a.inserts and albedo
    ):  # the inserts are cut deeper than the Moon's map: a build without it has none
        albedo["inserts"] = build_inserts(a.cache, stage, albedo["max"])
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
        # The tile source's pin (scripts/build_almanac_maxi.py reads it): committed with the release that carries the file.
        asset = {
            "file": os.path.basename(path),
            "size": os.path.getsize(path),
            "sha256": _sha_files([path]),
            "tag": a.tag,
        }
        with open(os.path.join(ROOT, "zimi", "assets", "almanac-tiles.json"), "w") as f:
            json.dump(asset, f, indent=2)
            f.write("\n")
        print("wrote zimi/assets/almanac-tiles.json for", a.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
