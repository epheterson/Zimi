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
ANTARCTIC_ICE_LAT = -60  # land south of this is ice
ARID_SHARE, GREEN_WINS = 0.30, 0.65  # a cell with this share of desert pixels is desert unless this share of it is green
LAND_SHARE = 0.25  # a cell with at least this much land is a land cell (a coast is the person's, not the sea's)


# The Arctic tree line, latitude by longitude (degrees east, wrapping): the northern limit of forest, from the circumpolar maps of the
# Arctic's vegetation zones (CAVM Team 2003, Circumpolar Arctic Vegetation Map, CAFF; Callaghan et al. 2002, Ambio 31). A coarse
# table good to a couple of degrees: colour alone cannot tell tundra from the taiga's last greens. Greenland and Iceland, where no
# forest grows, take a line so far south that all their ground is tundra. South of 55 S, with no trees at all, is tundra too.
TREE_LINE = [(-180, 66), (-170, 66), (-165, 60), (-160, 64), (-155, 68), (-145, 69), (-135, 68.5), (-125, 67), (-115, 64), (-105, 60), (-95, 58),
             (-85, 58), (-75, 58), (-68, 57), (-62, 57), (-55, 52), (-40, 52), (-25, 52), (-15, 52), (-10, 66), (0, 70), (10, 71), (20, 69.5),
             (30, 68.5), (40, 67), (50, 67.5), (60, 67), (70, 67), (80, 67.5), (90, 70.5), (100, 72), (110, 71), (120, 70), (130, 70),
             (140, 69), (150, 68.5), (160, 67), (170, 66), (180, 66)]
ANTARCTIC_TREE_FREE_LAT = -55


def tree_line(lon):
    """The latitude north of which no forest grows, at a longitude (degrees east)."""
    for (x0, y0), (x1, y1) in zip(TREE_LINE, TREE_LINE[1:]):
        if x0 <= lon <= x1:
            return y0 + (y1 - y0) * (lon - x0) / (x1 - x0)
    return 66.0


def treeless(lat, lon):
    return lat >= tree_line(lon) or lat <= ANTARCTIC_TREE_FREE_LAT


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


def classify(px, lat, lon):
    """Per Blue Marble pixel (float rgb 0..1, n x 3) at a latitude: a land class from its colour."""
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    spread = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    forest = BROADLEAF if abs(lat) < CONIFER_LAT else CONIFER
    cls = np.full(len(px), DESERT if abs(lat) < TUNDRA_LAT else TUNDRA, dtype=np.uint8)   # dry brown ground
    cls[(g >= r * GRASS_G_OVER_R) & (lum < DESERT_LUM)] = GRASS   # olive and green: crops, prairie, steppe
    cls[(g > r * FOREST_G_OVER_R) & (lum < FOREST_LUM)] = forest   # dark green
    cls[(lum >= DESERT_LUM) | ((r > g * 1.25) & (lum > 0.28))] = DESERT   # bright tan
    if treeless(lat, lon):  # past the tree line, whatever the colour says: ground that is not snow is tundra
        cls[:] = TUNDRA
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
            counts = np.bincount(classify(block, lat, cx - 180 + 0.5), minlength=7)
            cls = int(np.argmax(counts))
            green = int(counts[BROADLEAF] + counts[CONIFER] + counts[GRASS])
            # A river through a desert (the Nile) is a thin green line in a wide dry cell: dry wins unless the cell is mostly green.
            if counts[DESERT] >= ARID_SHARE * counts.sum() and green < GREEN_WINS * counts.sum() and cls != SNOW:
                cls = DESERT
            if lat < ANTARCTIC_ICE_LAT:  # the ice sheet and its shore: a rock or a dry valley in it does not make a beach
                cls = SNOW
            cells[cy, cx] = cls | coast
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
        ("Cairo", 30.04, 31.24),
        ("McMurdo", -77.85, 166.67),
        ("Utqiagvik", 71.3, -156.8),
        ("Iqaluit", 63.7, -68.5),
        ("Nuuk coast", 64.5, -50.5),
        ("Tiksi", 71.6, 128.9),
        ("Svalbard coast", 78.2, 15.6),
        ("Svalbard interior", 78.5, 17.0),
        ("Tierra del Fuego", -54.8, -68.3),
    ):
        c = cells[int(90 - lat), int(lon + 180)]
        print("%-12s %s%s" % (name, NAMES[c & 7], " coast" if c & COAST else ""))


if __name__ == "__main__":
    main()
