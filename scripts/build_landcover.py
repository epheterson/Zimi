"""Build the Earth's land cover grid, one degree a cell: zimi/static/earth/landcover-v1.bin.

    python scripts/build_landcover.py

One grid for every window on the Earth: the live sky card's foreground (almanac-skyland.js) and Stand here's trees and ground
(almanac-stand.js) both read it through almanac-oneland.js _osLandCover, so they cannot disagree about what grows where. It folds
two sources into one small file: the Blue Marble colour map (zimi/static/earth/earth-day-v1.webp, NASA Earth Observatory, public
domain) and the Natural Earth land mask (zimi/static/earth/land-v1.bin, scripts/build_landmask.py, public domain).

Format: "ZCOV", u8 version (1), u8 0, u16 width (360), u16 height (180); then
  plane A, the cells from the north-west, row by row, as runs: (u8 value, u8 length 1..255) pairs, up to width x height cells;
  plane B, for each cell that is not sea, in the same order: one byte of mean colour, red in the top three bits, green in the next
  three, blue in the last two (a tint, not a picture), each channel stored as its square root so the dark colours keep their hue.
A value is the class in its low three bits (0 sea, 1 broadleaf forest, 2 conifer forest, 3 grass, 4 shrub and desert, 5 snow and ice,
6 tundra) and 8 when the cell holds a coast (land and sea both in it).
Reading it back is almanac-oneland.js _olParse. A land cell takes the class most of its land pixels have: snow where the map is white,
desert where it is tan, forest where it is dark green (conifer from 44 degrees of latitude and in the cold, broadleaf below it),
grass where it is lighter green, and the rest bare: tundra poleward of 58 degrees, shrub below.
"""

import os
import struct

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
OUT = os.path.join(EARTH, "landcover-v1.bin")
W, H = 360, 180
SEA, BROADLEAF, CONIFER, GRASS, DESERT, SNOW, TUNDRA = range(7)
NAMES = ["sea", "broadleaf", "conifer", "grass", "shrub/desert", "snow/ice", "tundra"]
COAST = 8
COAST_LAND_SHARE = (
    0.03,
    0.97,
)  # a cell with this much land and this much sea holds a coast
CONIFER_LAT = (
    44  # firs and spruce from here to the poles (almanac-stand.js _aeStTreeKind)
)
TUNDRA_LAT = 58  # bare ground poleward of this is tundra, equatorward shrub
GRASS_G_OVER_R, FOREST_G_OVER_R = 0.88, 1.1  # the Blue Marble's greens: a pixel at least this green over red
FOREST_LUM, DESERT_LUM = 0.19, 0.36  # darker than this is forest (if green); brighter than this is desert
LAND_SHARE = 0.25  # a cell with at least this much land is a land cell (a coast is the person's, not the sea's)


def land_bits():
    """The Natural Earth mask as a 2-D array of 0 and 1, rows from the north (see build_landmask.py for the format)."""
    buf = open(os.path.join(EARTH, "land-v1.bin"), "rb").read()
    assert buf[:4] == b"ZLND" and buf[4] == 1
    w, h = struct.unpack_from("<HH", buf, 6)
    out = np.zeros((h, w), dtype=np.uint8)
    pos = 10
    for y in range(h):
        (n,) = struct.unpack_from("<H", buf, pos)
        pos += 2
        x = 0
        for i in range(n):
            (run,) = struct.unpack_from("<H", buf, pos)
            pos += 2
            if i % 2 == 1:
                out[y, x : x + run] = 1
            x += run
    return out


def classify(px, lat):
    """Per Blue Marble pixel (float rgb 0..1, n x 3) at a latitude: a land class from its colour."""
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    spread = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    forest = BROADLEAF if abs(lat) < CONIFER_LAT else CONIFER
    cls = np.full(len(px), DESERT if abs(lat) < TUNDRA_LAT else TUNDRA, dtype=np.uint8)   # dry brown ground
    cls[(g >= r * GRASS_G_OVER_R) & (lum < DESERT_LUM)] = GRASS   # olive and green: crops, prairie, steppe
    cls[(g > r * FOREST_G_OVER_R) & (lum < FOREST_LUM)] = forest   # dark green
    cls[(lum >= DESERT_LUM) | ((r > g * 1.25) & (lum > 0.28))] = DESERT   # bright tan
    cls[(np.minimum(np.minimum(r, g), b) > 0.62) & (spread < 0.16)] = SNOW
    return cls


def tint_byte(rgb):
    r, g, b = (int(round(min(1.0, max(0.0, c)) ** 0.5 * m)) for c, m in zip(rgb, (7, 7, 3)))   # square-rooted: the dark greens keep their hue
    return (r << 5) | (g << 2) | b


def runs(flat):
    out = bytearray()
    i = 0
    while i < len(flat):
        v, n = flat[i], 1
        while i + n < len(flat) and flat[i + n] == v and n < 255:
            n += 1
        out += bytes([v, n])
        i += n
    return out


def main():
    mask = land_bits()
    mh, mw = mask.shape
    bm = (
        np.asarray(
            Image.open(os.path.join(EARTH, "earth-day-v1.webp")).convert("RGB")
        ).astype(np.float32)
        / 255.0
    )
    bh, bw, _ = bm.shape
    cells = np.zeros((H, W), dtype=np.uint8)
    tints = []
    for cy in range(H):
        lat = 90 - (cy + 0.5)
        y0, y1 = int(cy * mh / H), int((cy + 1) * mh / H)
        by0, by1 = int(cy * bh / H), max(int(cy * bh / H) + 1, int((cy + 1) * bh / H))
        for cx in range(W):
            x0, x1 = int(cx * mw / W), int((cx + 1) * mw / W)
            share = float(mask[y0:y1, x0:x1].mean())
            coast = COAST if COAST_LAND_SHARE[0] < share < COAST_LAND_SHARE[1] else 0
            if share < LAND_SHARE:
                cells[cy, cx] = SEA | coast
                continue
            bx0, bx1 = int(cx * bw / W), max(
                int(cx * bw / W) + 1, int((cx + 1) * bw / W)
            )
            block = bm[by0:by1, bx0:bx1].reshape(-1, 3)
            cells[cy, cx] = (
                int(np.argmax(np.bincount(classify(block, lat), minlength=7))) | coast
            )
            tints.append(tint_byte(block.mean(axis=0)))
    out = bytearray(b"ZCOV" + struct.pack("<BBHH", 1, 0, W, H))
    out += runs(cells.reshape(-1))
    out += bytes(tints)
    open(OUT, "wb").write(out)
    for k, nm in enumerate(NAMES):
        print("%-13s %5d cells" % (nm, int(((cells & 7) == k).sum())))
    print("coast cells", int((cells >= COAST).sum()), "bytes", len(out))
    for name, lat, lon in (
        ("Boulder", 40.0, -105.3),
        ("Kerrville", 30.05, -99.14),
        ("Kansas", 38.5, -98.0),
        ("Black Forest", 48.2, 8.2),
        ("New York", 40.7, -74.0),
        ("Sahara", 25.0, 10.0),
        ("Amazon", -3.0, -60.0),
        ("Siberia", 62.0, 100.0),
        ("Greenland", 72.0, -40.0),
        ("Antarctica", -80.0, 0.0),
        ("Honolulu", 21.3, -157.9),
    ):
        c = cells[int(90 - lat), int(lon + 180)]
        print("%-12s %s%s" % (name, NAMES[c & 7], " coast" if c & COAST else ""))


if __name__ == "__main__":
    main()
