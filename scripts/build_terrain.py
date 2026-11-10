"""Build the Almanac's terrain: the heights Stand here walks on.

    python scripts/build_terrain.py [--cache DIR] [--bodies moon,mars,...] [--tiles DIR] [--check]

The 3D view (almanac-earth.js, almanac-stand.js) lets someone stand on the ground of any body with a surface. The
ground's large shape is real: a global height map of the body, public-domain data resampled here to 4096 x 2048
(plate carree, longitude -180..180 eastward, latitude +90 at the top, metres above the body's mean radius). Two things
come from that one master per body:

  * zimi/static/earth/terrain-<body>-v1.bin, 1024 x 512, shipped with Zimi (about 1 MB each, a fifth of that compressed). Format: "ZTRN", u8
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
COARSE_W, COARSE_H = 1024, 512   # the shipped map: about 20 km a cell (it was 256 x 128, 156 km: most mountains were not there)
TILE = 256
TERRAIN_MAX = 3  # the deepest HD level unless TERRAIN_LEVELS says more: the master holds 256 * 2^3 = 2048 rows
#: Each body's deepest HD level: the shallowest that holds every source pixel (native_level), its tiles cut at the
#: source's own size (terrain_tiles native): ETOPO 2022's 60 arc-seconds at 6 (169 px tiles), LOLA's and MESSENGER's
#: 64 pixels a degree at 6 (180), Magellan at 4 (256), MOLA's 128 at 7 (180), Ceres 6 (169), Vesta 6 (135), Pluto 6 (194),
#: Charon 5 (198), Phobos and Enceladus 1. A build that must be smaller caps a body lower (build_almanac_hd --caps).
TERRAIN_LEVELS = {"earth": 6, "moon": 6, "mercury": 6, "venus": 4, "mars": 7, "ceres": 6, "vesta": 6, "pluto": 6, "charon": 5, "phobos": 1, "enceladus": 1}


def levels_for(key):
    return TERRAIN_LEVELS.get(key, TERRAIN_MAX)
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
        "url": SVS + "ldem_64_uint.tif",
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
    # The small worlds with a global elevation model in the public domain (USGS Astrogeology). ``lon0`` is the picture's
    # left edge as its own GeoTIFF keys put it (the central meridian plus the tiepoint), not as its file name suggests:
    # Ceres, Pluto and Enceladus run 0-360. ``ppd``: pixels a degree where the picture is not exactly 360 degrees wide
    # (Phobos's and Charon's carry a few columns past the globe), and then ``lon0`` is its fractional left edge.
    # Heights are metres above each model's reference sphere (its label's radius).
    "ceres": {   # above a 470 km sphere; the view's Ceres is 469.7 km
        "url": USGS + "Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif",
        "lon0": 0,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -32768,
        "shift": 300.0,
    },
    "vesta": {   # radii from the centre, metres: heights above its biaxial ellipsoid (a sphere would not fit 16 bits)
        "url": USGS + "Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif",
        "lon0": -180,
        "ellipsoid": (282450.0, 223200.0),
        "scale": 1.0,
        "offset": 0.0,
        "nodata_below": -1e30,
        "nodata": None,
        "shift": 0.0,
    },
    "pluto": {
        "url": USGS + "Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif",
        "lon0": 0,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -32768,
        "shift": 0.0,
    },
    "charon": {
        "url": USGS + "Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif",
        "lon0": -180.014,
        "ppd": 35.255651,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -32768,
        "shift": 0.0,
    },
    "phobos": {
        "url": USGS + "Phobos_ME_HRSC_DEM_Global_2ppd.tif",
        "lon0": -180.146,
        "ppd": 1.9373,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": -32768,
        "shift": 0.0,
    },
    "enceladus": {
        "url": USGS + "Enceladus/enceladus_cassini_iss_shapemodel_bland_2019/enceladus_2019pm_topography.tif",
        "lon0": 0,
        "scale": 1.0,
        "offset": 0.0,
        "nodata_below": -1e30,
        "nodata": None,
        "shift": 0.0,
    },
}

# SHA-256 of each source file.
PINS = {
    "earth": "9d27d4b8ea8e76977e2988bca667d7c8fa68b927355feffcddd6b4875a7fd08e",
    "moon": "0f40bce8b42864deddb6943a38474879e691d5b20647aa5e54c2612b23106499",
    "mars": "38a4eb0b4452855b8dabfac40a367b458555ab4c01b31235807ad0a53c031f4c",
    "venus": "92dd2c8850b128f9dcceb400f1367e3df96229f5309840fee4275b74f192ea11",
    "mercury": "defce776241dcaf44cb0f081ee508c17dbea28aa5a22880bf7a5e8c25f96cbea",
    "ceres": "81da73151b4353c03d7ca18fa85972d1cb9c8530b3c5496df9ade7cb75af1915",
    "vesta": "a5d7b2a4101a31900b205ccfd12a4bdb84ad44bc5ac77de78dd89d6237bc5da8",
    "pluto": "259b3e962540285f9833b13b4ad28c6b38aadb68300a52d733990b4b8870a640",
    "charon": "4496de98a9b682fd3440da616ef7f5adfbc315b438e4d18833ae3a843eb41bcc",
    "phobos": "4700588cb0ffb423bb884b29c4dd8f2b98ceaf263dd90f9e097866486234192c",
    "enceladus": "33e0e1a0409f5194f5b8b534b83c5d4ada8c12f23d3438bcdb06f079ed7cea54",
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
    if (w, h) == (MASTER_W, MASTER_H) and spec["lon0"] == -180 and not spec.get("ppd"):
        # The master is the source's own grid (a native deepest level): read it as it is, a band at a time.
        out = np.empty((h, w), dtype=np.float32)
        for y0 in range(0, h, 256):
            raw = rows(y0, min(h, y0 + 256)).astype(np.float32)
            bad = ~np.isfinite(raw)
            if spec["nodata"] is not None:
                bad |= raw == spec["nodata"]
            if spec.get("nodata_below") is not None:
                bad |= raw <= spec["nodata_below"]
            raw = raw * spec["scale"] + spec["offset"] + spec["shift"]
            raw[bad] = np.nan
            out[y0 : y0 + raw.shape[0]] = raw
        out = _less_ellipsoid(out, spec)
        return _fill_holes(out) if np.isnan(out).any() else out
    if spec.get("ppd"):   # not exactly the globe: the source columns under each master column's edges, from its own left edge
        base = -180.0 if spec["lon0"] < -90 else 0.0
        xe = np.clip((np.linspace(base, base + 360.0, MASTER_W + 1) - spec["lon0"]) * spec["ppd"], 0, w)
    else:
        xe = np.linspace(0, w, MASTER_W + 1)
    total = np.zeros((MASTER_H, MASTER_W), dtype=np.float32)   # float32: the Earth's master is 32768 x 16384
    weight = np.zeros((MASTER_H, MASTER_W), dtype=np.float32)
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
        if spec.get("nodata_below") is not None:
            ok &= raw > spec["nodata_below"]
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
    out = _less_ellipsoid(out, spec)
    if not spec.get("ppd") and spec["lon0"] != -180:
        out = np.roll(
            out, int(round((-180 - spec["lon0"]) / 360.0 * MASTER_W)) % MASTER_W, axis=1
        )
    return _fill_holes(out).astype(np.float32)


#: Where a model has a hole (a pole never seen: Pluto's south, Vesta's north), the filled ground is smoothed this far
#: (a share of the master's height in pixels): a guess should read as a gentle surface, not the streaks the pass-by-pass
#: fill leaves along the meridians.
HOLE_SMOOTH = 1.0 / 256


def _less_ellipsoid(a, spec):
    """Radii (a model that gives the distance from the centre: Vesta's) as heights above the body's ellipsoid of
    revolution (``ellipsoid``: equatorial and polar radii), row by row; anything else as it is. Vesta's radii run from
    212 to 293 km: no sphere holds them in 16 bits, its ellipsoid does (about -20 to +15 km)."""
    import numpy as np

    if not spec.get("ellipsoid"):
        return a
    eq, pol = spec["ellipsoid"]
    h = a.shape[0]
    lat = np.deg2rad(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    r = eq * pol / np.sqrt((pol * np.cos(lat)) ** 2 + (eq * np.sin(lat)) ** 2)
    return (a - r[:, None]).astype(np.float32)


def _fill_holes(a):
    """Holes (no source value: the poles of some mosaics) take the mean of what is round them, passes until none are
    left, then are smoothed (HOLE_SMOOTH); the measured ground is untouched."""
    import numpy as np

    hole = np.isnan(a)
    a = _fill_passes(a)
    if hole.any():
        from scipy.ndimage import gaussian_filter

        sigma = max(1.0, a.shape[0] * HOLE_SMOOTH)
        smooth = gaussian_filter(a, sigma, mode=("nearest", "wrap"))
        a = np.where(hole, smooth, a).astype(a.dtype)
    return a


def _fill_passes(a):
    """Each hole pixel takes the mean of the known ground round it at the finest scale that has some: the picture is
    halved (a nan-aware mean of each 2 x 2) until the holes close, and the coarse values fill the fine holes on the way
    back up. Linear in the picture's size, where filling one ring of neighbours a pass took minutes on a hemisphere
    never seen (Charon's, Pluto's south)."""
    import numpy as np

    a = a.astype(np.float32, copy=True)
    bad = np.isnan(a)
    if not bad.any():
        return a
    if not (~bad).any():
        return np.zeros_like(a)
    h, w = a.shape
    ph, pw = h + (h % 2), w + (w % 2)
    pad = np.full((ph, pw), np.nan, dtype=np.float32)
    pad[:h, :w] = a
    blocks = pad.reshape(ph // 2, 2, pw // 2, 2)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        coarse = np.nanmean(blocks, axis=(1, 3))
    coarse = _fill_passes(coarse)
    up = np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)[:h, :w]
    a[bad] = up[bad]
    return a


def block_mean(a, w, h):
    """a (rows x cols, both multiples of h / w) averaged down to h x w."""
    r, c = a.shape
    return a.reshape(h, r // h, w, c // w).mean(axis=(1, 3))


#: The shipped map's size for the small worlds: 256 x 128 (64 KB each). Standing there the HD tiles carry the detail;
#: the package stays light (the big five ship 1024 x 512).
COARSE_SMALL = {"ceres", "vesta", "pluto", "charon", "phobos", "enceladus"}


def coarse_size(key):
    return (256, 128) if key in COARSE_SMALL else (COARSE_W, COARSE_H)


def coarse_bytes(m, size=None):
    """terrain-<body>-v1.bin from the master."""
    import numpy as np

    w, h = size or (COARSE_W, COARSE_H)
    small = np.clip(np.rint(block_mean(m, w, h)), -32768, 32767).astype("<i2")
    return MAGIC + struct.pack("<BBHH", 1, 0, w, h) + small.tobytes()


def write_coarse(key, m, out_dir=EARTH_DIR):
    path = os.path.join(out_dir, "terrain-%s-v1.bin" % key)
    with open(path, "wb") as f:
        f.write(coarse_bytes(m, coarse_size(key)))
    return path


def _save_tile(arr, path):
    import numpy as np
    from PIL import Image

    u = np.clip(np.rint(arr) + TILE_OFFSET, 0, 65535).astype(np.uint16)
    rgb = np.zeros(u.shape + (3,), dtype=np.uint8)
    rgb[..., 0], rgb[..., 1] = u >> 8, u & 255
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(rgb, "RGB").save(path, "WEBP", lossless=True, method=4)


#: Each body's deepest level's tile size as the last build made it (``px`` in hd.json when it is not TILE).
TOP_PX = {}


def source_ppd(key, cache, update=False):
    """The source's pixels a degree of longitude."""
    spec = SOURCES[key]
    if spec.get("ppd"):
        return spec["ppd"]
    w, _h, _rows = _rows_reader(source_path(key, cache, update))
    return w / 360.0


def native_level(key, cache, update=False):
    """The shallowest level whose tiles hold every source pixel: TILE * 2^(z+1) columns at least the source's."""
    ppd = source_ppd(key, cache, update)
    z = 0
    while 180.0 / 2**z * ppd > TILE:
        z += 1
    return z


def _resample(a, cols, rows):
    """An area mean of ``a`` to cols x rows, for sizes that do not divide (a native deepest level's grid)."""
    import numpy as np
    from PIL import Image

    if a.shape[0] % rows == 0 and a.shape[1] % cols == 0:
        return block_mean(a, cols, rows)
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize((cols, rows), Image.BOX), dtype=np.float32)


def terrain_tiles(key, cache, out, update=False, max_level=None, native=False):
    """terrain/<body>/<z>/<x>/<y>.webp for z = 0..max_level under ``out``; returns the deepest level.

    ``native``: the deepest level is stored at the source's own pixel size (fewer than TILE a side where TILE would
    magnify it; TOP_PX says how many, and hd.json carries it as ``px``), so it holds every source pixel and invents
    none. The levels above are TILE a side, area means of it."""
    global MASTER_W, MASTER_H
    max_level = levels_for(key) if max_level is None else max_level
    top_px = TILE
    if native:
        top_px = min(TILE, int(round(180.0 / 2**max_level * source_ppd(key, cache, update))))
    rows = top_px * 2**max_level
    old = (MASTER_W, MASTER_H)
    if rows != MASTER_H and (native or rows > MASTER_H):   # the master holds the deepest level's pixels
        MASTER_W, MASTER_H = 2 * rows, rows
    try:
        m = master(key, cache, update)
    finally:
        MASTER_W, MASTER_H = old
    TOP_PX[key] = top_px
    lvl = m
    del m
    for z in range(max_level, -1, -1):
        px = top_px if z == max_level else TILE
        rows, cols = px * 2**z, px * 2 ** (z + 1)
        if lvl.shape != (rows, cols):
            lvl = _resample(lvl, cols, rows)
        for y in range(2**z):
            for x in range(2 ** (z + 1)):
                _save_tile(
                    lvl[y * px : (y + 1) * px, x * px : (x + 1) * px],
                    os.path.join(out, "terrain", key, str(z), str(x), "%d.webp" % y),
                )
    print("terrain/%s: levels 0-%d, the deepest %d px a side" % (key, max_level, top_px))
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
