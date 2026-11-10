"""Build the Earth's night-lights grid, one degree a cell: zimi/static/earth/nightlights-v1.bin.

    python scripts/build_nightlights.py

The live sky's light-pollution dial starts where the place says it should: a city under its own glow, a desert under none. The grid is the
Black Marble night map the 3D Earth already ships (zimi/static/earth/earth-night-v1.webp, NASA Earth Observatory, public domain) folded
to one byte a degree: the brightness near the 90th percentile of the cell's pixels (so a city in a wide cell is not averaged away by the
dark country round it) above the map's own dim ground, square-rooted and scaled to 0..255 (0 dark, 255 a bright metropolis). almanac-onesky.js _osNightDial turns it into the dial.

Format: "ZNLT", u8 version (1), u8 0, u16 width (360), u16 height (180), then the cells from the north-west, row by row, as runs:
(u8 value, u8 length 1..255) pairs.
"""

import os
import struct

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
OUT = os.path.join(EARTH, "nightlights-v1.bin")
W, H = 360, 180
PERCENTILE = 90
BASELINE = 0.21  # the map's own dim ground (land and sea carry a flat 0.02 to 0.2 of the composite): only what is brighter than it is light
LUM_FULL = 1.0  # a pixel this bright (0..1 luminance of the Black Marble) is the top of the scale


def main():
    im = (
        np.asarray(
            Image.open(os.path.join(EARTH, "earth-night-v1.webp")).convert("RGB")
        ).astype(np.float32)
        / 255.0
    )
    lum = 0.2126 * im[..., 0] + 0.7152 * im[..., 1] + 0.0722 * im[..., 2]
    bh, bw = lum.shape
    cells = np.zeros((H, W), dtype=np.uint8)
    for cy in range(H):
        y0, y1 = int(cy * bh / H), max(int(cy * bh / H) + 1, int((cy + 1) * bh / H))
        for cx in range(W):
            x0, x1 = int(cx * bw / W), max(int(cx * bw / W) + 1, int((cx + 1) * bw / W))
            v = float(np.percentile(lum[y0:y1, x0:x1], PERCENTILE))
            cells[cy, cx] = int(round(255 * min(1.0, (max(0.0, v - BASELINE) / (LUM_FULL - BASELINE)) ** 0.5)))
    flat = cells.reshape(-1)
    out = bytearray(b"ZNLT" + struct.pack("<BBHH", 1, 0, W, H))
    i = 0
    while i < len(flat):
        v, n = flat[i], 1
        while i + n < len(flat) and flat[i + n] == v and n < 255:
            n += 1
        out += bytes([v, n])
        i += n
    open(OUT, "wb").write(out)
    print("bytes", len(out))
    for name, lat, lon in (
        ("Los Angeles", 34.05, -118.25),
        ("Singapore", 1.35, 103.82),
        ("New York", 40.71, -74.0),
        ("Boulder", 40.0, -105.3),
        ("Kerrville", 30.05, -99.14),
        ("Salina", 38.8, -97.6),
        ("Sahara", 25.0, 10.0),
        ("Mid-Pacific", 0.0, -140.0),
        ("Black Forest", 47.8, 8.2),
        ("Cairo", 30.04, 31.24),
        ("Greenland", 72.0, -40.0),
        ("Tokyo", 35.7, 139.7),
    ):
        print("%-13s %3d" % (name, cells[int(90 - lat), int(lon + 180)]))


if __name__ == "__main__":
    main()
