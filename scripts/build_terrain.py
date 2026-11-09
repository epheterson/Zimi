"""Build the Almanac's terrain: the heights Stand here walks on.

    python scripts/build_terrain.py [--cache DIR] [--bodies moon,mars,...] [--tiles DIR] [--check]

The 3D view (almanac-earth.js, almanac-stand.js) lets someone stand on the ground of any body with a surface. The
ground's large shape is real: a global height map of the body, public-domain data resampled here to 4096 x 2048
(plate carree, longitude -180..180 eastward, latitude +90 at the top, metres above the body's mean radius). Two things
come from that one master per body:

  * zimi/static/earth/terrain-<body>-v1.bin, 256 x 128, shipped with Zimi (about 64 KB each). Format: "ZTRN", u8
    version, u8 flags (0), u16 width, u16 height, then width x height little-endian int16 metres, rows from the north.
  * the Almanac HD tiles ``terrain/<body>/<z>/<x>/<y>.webp`` (build_almanac_hd.py calls ``terrain_tiles``): 256 px
    tiles on the same plate carree grid as the HD maps (level z holds 2^(z+1) x 2^z tiles), a height as a 16-bit
    number in red (high byte) and green (low byte): metres + 32768, lossless. Down to level TERRAIN_MAX (about 11
    pixels a degree: 2.6 km a pixel on the Moon), the finest the master holds without inventing pixels.

Below that, the view adds generated detail (craters, ridges, rock) that it says is generated; no source here has
metre-scale heights for more than a few places.

Sources (all public domain, credited in zimi/static/earth/SOURCES.txt and the 3D view's credits):
  earth    NOAA NCEI, ETOPO 2022 (60 arc-second, surface), heights above the EGM2008 geoid. U.S. Government work.
  moon     NASA SVS CGI Moon Kit, LOLA elevation at 16 pixels a degree (ldem_16_uint.tif, half-metres + 20,000).
  mars     USGS Astrogeology, MOLA DEM mosaic, 463 m (Mars_MGS_MOLA_DEM_mosaic_global_463m.tif), above the areoid.
  venus    USGS Astrogeology, Magellan topography, 4641 m (Venus_Magellan_Topography_Global_4641m_v02.tif).
  mercury  USGS Astrogeology, MESSENGER MDIS/MLA DEM, 665 m (Mercury_Messenger_USGS_DEM_Global_665m_v2.tif).
Titan, Pluto, Io, Europa, Ganymede and Callisto have no global height map in the public domain at a usable
resolution, so they stand on a smooth sphere of their radius with generated detail.

Reproducible: every source is fetched into the cache and checked against the pin (SHA-256 of the file);
``--update-pins`` prints new pins instead of failing.
"""

import argparse
import hashlib
import os
import struct
import subprocess
import sys
import warnings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH_DIR = os.path.join(ROOT, "zimi", "static", "earth")

MASTER_W, MASTER_H = 4096, 2048
COARSE_W, COARSE_H = 256, 128
TILE = 256
TERRAIN_MAX = 3  # the deepest HD level: the master holds 256 * 2^3 = 2048 rows
TILE_OFFSET = 32768
MAGIC = b"ZTRN"

SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
USGS = "https://planetarymaps.usgs.gov/mosaic/"
ETOPO = "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/"

#: How each body's source is read. ``lon0``: the longitude of the picture's left edge. ``scale`` and ``offset``:
#: metres = raw * scale + offset. ``nodata``: raw values that are holes. ``shift``: metres added to bring the source's
#: reference sphere to the body's mean radius in zimi/static/almanac-stand.js (AE_STAND_BODIES).
SOURCES = {
    "earth": {
        "url": ETOPO + "ETOPO_2022_v1_60s_N90W180_surface.tif",
        "lon0": -180,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -99999,
        "shift": 0.0,
    },
    "moon": {
        "url": SVS + "ldem_16_uint.tif",
        "lon0": -180,
        "scale": 0.5,
        "offset": -10000.0,
        "nodata": None,
        "shift": 0.0,
    },
    "mars": {
        "url": USGS + "Mars_MGS_MOLA_DEM_mosaic_global_463m.tif",
        "lon0": -180,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -32768,
        "shift": 0.0,
    },
    "venus": {
        "url": USGS + "Venus_Magellan_Topography_Global_4641m_v02.tif",
        "lon0": -180,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -32768,
        "shift": -840.0,
    },
    "mercury": {
        "url": USGS + "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif",
        "lon0": 0,
        "scale": 0.5,
        "offset": 0.0,
        "nodata": -32768,
        "shift": 300.0,
    },
}

# SHA-256 of each source file.
PINS = {
    "earth": "9d27d4b8ea8e76977e2988bca667d7c8fa68b927355feffcddd6b4875a7fd08e",
    "moon": "45a2b32d56e81ed30db07fead8abc842b249b6511219d9ca2c53f81bc2dc5d62",
    "mars": "38a4eb0b4452855b8dabfac40a367b458555ab4c01b31235807ad0a53c031f4c",
    "venus": "92dd2c8850b128f9dcceb400f1367e3df96229f5309840fee4275b74f192ea11",
    "mercury": "defce776241dcaf44cb0f081ee508c17dbea28aa5a22880bf7a5e8c25f96cbea",
}


def _fetch(url, path, tries=4):
    """Stream a source to disk with curl (Mars is 2 GB; curl also speaks the TLS the agencies' servers want)."""
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(
        ["curl", "-sSL", "--fail", "--retry", str(tries), "-A", "Zimi-build/1.0 (https://github.com/epheterson/Zimi)",
         "-o", path + ".part", url],
        check=True,
    )
    os.replace(path + ".part", path)
    return path


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _check_pin(key, digest, update):
    want = PINS.get(key)
    if update or not want:
        print("pin %s %s" % (key, digest))
        return
    if digest != want:
        sys.exit(
            "%s: source changed (%s, pinned %s); rerun with --update-pins after checking it"
            % (key, digest, want)
        )


def source_path(key, cache, update=False):
    spec = SOURCES[key]
    path = _fetch(
        spec["url"], os.path.join(cache, "files", os.path.basename(spec["url"]))
    )
    _check_pin(key, _sha(path), update)
    return path


def _rows_reader(path):
    """(width, height, rows(y0, y1) -> 2-D array of raw values) for a GeoTIFF: uncompressed strips are read straight
    from the file (the planetary mosaics are, and Pillow cannot read their signed 16-bit rows), anything else by Pillow.
    """
    import numpy as np
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    im = Image.open(path)
    tags = im.tag_v2
    w, h = im.size
    bits, fmt, comp = tags.get(258, (8,))[0], tags.get(339, (1,))[0], tags.get(259, 1)
    if comp == 1 and bits == 16 and 273 in tags:
        strips, rps = tags[273], tags.get(278, h)
        dtype = np.dtype("<i2" if fmt == 2 else "<u2")
        if isinstance(rps, tuple):
            rps = rps[0]
        mm = np.memmap(path, dtype=np.uint8, mode="r")

        def rows(y0, y1):
            out = np.empty((y1 - y0, w), dtype=dtype)
            for y in range(y0, y1):
                off = strips[y // rps] + (y % rps) * w * 2
                out[y - y0] = mm[off : off + w * 2].view(dtype)
            return out

        return w, h, rows
    arr = np.asarray(im)

    def rows(y0, y1):
        return arr[y0:y1]

    return w, h, rows


def _axis_mean(cs, edges, n):
    """Cumulative sums along the last axis (a leading zero column) read at fractional ``edges``: the sums over each
    bin, so a bin is an exact area mean even where the source's pixels do not divide evenly.
    """
    import numpy as np

    i0 = np.minimum(np.floor(edges).astype(int), n)
    f = edges - i0
    i1 = np.minimum(i0 + 1, n)
    at = cs[..., i0] * (1 - f) + cs[..., i1] * f
    return at[..., 1:] - at[..., :-1]


def master(key, cache, update=False):
    """The body's heights as a MASTER_H x MASTER_W float32 array, metres above the mean radius; holes filled."""
    import numpy as np

    spec = SOURCES[key]
    path = source_path(key, cache, update)
    w, h, rows = _rows_reader(path)
    xe = np.linspace(0, w, MASTER_W + 1)
    total = np.zeros((MASTER_H, MASTER_W))
    weight = np.zeros((MASTER_H, MASTER_W))
    band = 64
    for y0 in range(0, h, band):
        y1 = min(h, y0 + band)
        raw = rows(y0, y1).astype(np.float64)
        ok = (
            np.ones(raw.shape, dtype=bool)
            if spec["nodata"] is None
            else raw != spec["nodata"]
        )
        ok &= np.isfinite(raw)
        val = np.where(ok, raw * spec["scale"] + spec["offset"] + spec["shift"], 0.0)
        csv = np.concatenate([np.zeros((y1 - y0, 1)), np.cumsum(val, axis=1)], axis=1)
        csw = np.concatenate(
            [np.zeros((y1 - y0, 1)), np.cumsum(ok.astype(np.float64), axis=1)], axis=1
        )
        cv, cw = _axis_mean(csv, xe, w), _axis_mean(
            csw, xe, w
        )  # sums over each master column
        # Each source row feeds the master row(s) it overlaps, by the share of it inside.
        for r in range(y1 - y0):
            top, bot = (y0 + r) * MASTER_H / h, (y0 + r + 1) * MASTER_H / h
            j = int(top)
            while j < MASTER_H and j < bot:
                share = (min(bot, j + 1) - max(top, j)) * h / MASTER_H
                total[j] += cv[r] * share
                weight[j] += cw[r] * share
                j += 1
    out = np.where(weight > 0, total / np.maximum(weight, 1e-9), np.nan)
    if spec["lon0"] != -180:
        out = np.roll(
            out, int(round((-180 - spec["lon0"]) / 360.0 * MASTER_W)) % MASTER_W, axis=1
        )
    return _fill_holes(out).astype(np.float32)


def _fill_holes(a):
    """Holes (no source value: the poles of some mosaics) take the mean of what is round them, passes until none are left."""
    import numpy as np

    a = a.copy()
    for _ in range(MASTER_H):
        bad = np.isnan(a)
        if not bad.any():
            break
        pad = np.pad(a, 1, mode="edge")
        stack = np.stack(
            [
                pad[:-2, 1:-1],
                pad[2:, 1:-1],
                np.roll(a, 1, axis=1),
                np.roll(a, -1, axis=1),
            ]
        )
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(stack, axis=0)
        a[bad] = mean[bad]
    return np.nan_to_num(a, nan=0.0)


def block_mean(a, w, h):
    """a (rows x cols, both multiples of h / w) averaged down to h x w."""
    r, c = a.shape
    return a.reshape(h, r // h, w, c // w).mean(axis=(1, 3))


def coarse_bytes(m):
    """terrain-<body>-v1.bin from the master."""
    import numpy as np

    small = np.clip(np.rint(block_mean(m, COARSE_W, COARSE_H)), -32768, 32767).astype(
        "<i2"
    )
    return MAGIC + struct.pack("<BBHH", 1, 0, COARSE_W, COARSE_H) + small.tobytes()


def write_coarse(key, m, out_dir=EARTH_DIR):
    path = os.path.join(out_dir, "terrain-%s-v1.bin" % key)
    with open(path, "wb") as f:
        f.write(coarse_bytes(m))
    return path


def _save_tile(arr, path):
    import numpy as np
    from PIL import Image

    u = np.clip(np.rint(arr) + TILE_OFFSET, 0, 65535).astype(np.uint16)
    rgb = np.zeros(u.shape + (3,), dtype=np.uint8)
    rgb[..., 0], rgb[..., 1] = u >> 8, u & 255
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(rgb, "RGB").save(path, "WEBP", lossless=True, method=4)


def terrain_tiles(key, cache, out, update=False, max_level=TERRAIN_MAX):
    """terrain/<body>/<z>/<x>/<y>.webp for z = 0..max_level under ``out``; returns the deepest level."""
    m = master(key, cache, update)
    for z in range(max_level + 1):
        rows, cols = TILE * 2**z, TILE * 2 ** (z + 1)
        lvl = block_mean(m, cols, rows) if (rows, cols) != m.shape else m
        for y in range(2**z):
            for x in range(2 ** (z + 1)):
                _save_tile(
                    lvl[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE],
                    os.path.join(out, "terrain", key, str(z), str(x), "%d.webp" % y),
                )
    print("terrain/%s: levels 0-%d" % (key, max_level))
    return max_level


def read_coarse(path):
    import numpy as np

    with open(path, "rb") as f:
        data = f.read()
    ver, _flags, w, h = struct.unpack("<BBHH", data[4:10])
    assert data[:4] == MAGIC and ver == 1 and len(data) == 10 + w * h * 2
    return np.frombuffer(data, dtype="<i2", offset=10).reshape(h, w)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(ROOT, "build", "almanac-hd-cache"))
    ap.add_argument("--bodies", default=",".join(SOURCES))
    ap.add_argument("--update-pins", action="store_true")
    ap.add_argument(
        "--check",
        action="store_true",
        help="print the heights the tests rely on, after writing",
    )
    a = ap.parse_args(argv)
    for key in [k for k in a.bodies.split(",") if k]:
        m = master(key, a.cache, a.update_pins)
        print("%s: %s" % (key, write_coarse(key, m)))
        if a.check:
            c = read_coarse(os.path.join(EARTH_DIR, "terrain-%s-v1.bin" % key))
            print("  min %d max %d metres" % (c.min(), c.max()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
