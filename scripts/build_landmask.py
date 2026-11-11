"""Build the Earth's land and sea mask for Stand here: zimi/static/earth/land-v1.bin.

    python scripts/build_landmask.py [ne_10m_land.geojson]

Stand here (almanac-stand.js) needs to know where the sea is. The shipped height map is 156 km a pixel, so a coast
is not in it; the Blue Marble's colour is 17 km a pixel and mistakes shallows and lakes. Natural Earth's 1:10 million
land polygons (public domain, the same repository scripts/build_admin1.py reads) are rasterised here to 8192 x 4096
(plate carree, 4.9 km a pixel at the equator, longitude -180 at the left, latitude +90 at the top) and stored as runs.

Format: "ZLND", u8 version (1), u8 0, u16 width, u16 height, then per row (from the north) a u16 run count and that many
u16 run lengths, alternating sea, land, sea... starting with sea (a first run of 0 when the row starts on land).
Reading it back is almanac-terrain.js _aeTerrainLandParse. Lakes are left as land: the Great Lakes stand as ground.
"""

import json
import os
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"
WIDTH, HEIGHT = 8192, 4096
MAGIC = b"ZLND"
OUT = os.path.join(ROOT, "zimi", "static", "earth", "land-v1.bin")


def fetch(path):
    if not os.path.exists(path):
        subprocess.run(
            ["curl", "-sSL", "--fail", "--retry", "3", "-o", path + ".part", URL],
            check=True,
        )
        os.replace(path + ".part", path)
    return path


def rasterise(geojson_path, width=WIDTH, height=HEIGHT):
    """The land polygons as a height x width array of 0 (sea) and 1 (land)."""
    import numpy as np
    from PIL import Image, ImageDraw

    with open(geojson_path, encoding="utf-8") as f:
        data = json.load(f)
    im = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(im)

    def px(ring):
        return [
            ((lon + 180.0) / 360.0 * width, (90.0 - lat) / 180.0 * height)
            for lon, lat in ring
        ]

    for feat in data["features"]:
        geom = feat["geometry"]
        polys = (
            geom["coordinates"]
            if geom["type"] == "MultiPolygon"
            else [geom["coordinates"]]
        )
        for poly in polys:
            draw.polygon(px(poly[0]), fill=1)
            for hole in poly[1:]:
                draw.polygon(px(hole), fill=0)
    return np.asarray(im, dtype=np.uint8)


def encode(mask):
    """Runs per row, as the format above says."""
    import numpy as np

    h, w = mask.shape
    out = bytearray(MAGIC + struct.pack("<BBHH", 1, 0, w, h))
    for row in mask:
        change = np.flatnonzero(np.diff(row.astype(np.int8))) + 1
        edges = np.concatenate(([0], change, [w]))
        runs = np.diff(edges).tolist()
        if row[0] == 1:
            runs.insert(0, 0)
        out += struct.pack("<H", len(runs)) + struct.pack("<%dH" % len(runs), *runs)
    return bytes(out)


def decode(data):
    import numpy as np

    assert data[:4] == MAGIC and data[4] == 1
    w, h = struct.unpack("<HH", data[6:10])
    mask = np.zeros((h, w), dtype=np.uint8)
    pos = 10
    for y in range(h):
        (n,) = struct.unpack_from("<H", data, pos)
        pos += 2
        runs = struct.unpack_from("<%dH" % n, data, pos)
        pos += 2 * n
        x = 0
        for i, r in enumerate(runs):
            if i % 2 == 1:
                mask[y, x : x + r] = 1
            x += r
        assert x == w
    assert pos == len(data)
    return mask


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    src = argv[0] if argv else fetch(os.path.join(ROOT, "build", "ne_10m_land.geojson"))
    mask = rasterise(src)
    data = encode(mask)
    with open(OUT, "wb") as f:
        f.write(data)
    print("%s: %d bytes, %.1f%% land" % (OUT, len(data), 100.0 * mask.mean()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
