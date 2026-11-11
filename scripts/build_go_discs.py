#!/usr/bin/env python3
"""Draw the Go to sheet's little bodies: one sprite sheet of lit discs, from the base maps the 3D view already ships.

python3 scripts/build_go_discs.py            writes zimi/static/earth/go-discs-v1.webp
python3 scripts/build_go_discs.py --check    fails if the file is not what this script makes (needs the same Pillow)

Each body is its equirectangular map seen from straight above its equator, lit from the upper left (the light is wrapped so
the dark side stays readable at 48 px), the limb a little darker. Saturn carries its rings. No texture is added for this:
every pixel comes from a map under zimi/static/earth/. The order below is the order of AE_GO_DISC_KEYS in almanac-earth.js
(tests/test_almanac_go_sheet_browser.py checks they agree).
"""

import math
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH_DIR = os.path.join(ROOT, "zimi", "static", "earth")
OUT = os.path.join(EARTH_DIR, "go-discs-v1.webp")

# Sheet order; the Earth's map is earth-day, the others <key>-v1.webp.
KEYS = [
    "sun",
    "earth",
    "moon",
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "pluto",
    "ceres",
    "vesta",
    "io",
    "europa",
    "ganymede",
    "callisto",
    "titan",
    "mimas",
    "enceladus",
    "tethys",
    "dione",
    "rhea",
    "iapetus",
    "triton",
    "charon",
    "phobos",
]
MAP_FILE = {"earth": "earth-day-v1.webp"}
CELL = 96  # pixels a disc is drawn at (48 CSS px at 2x)
COLUMNS = 7
QUALITY = 80
LIGHT = np.array(
    [-0.55, -0.6, 0.58]
)  # toward the Sun: upper left, a little toward the viewer
LIGHT = LIGHT / np.linalg.norm(LIGHT)
WRAP = 0.38  # how much of the dark side still shows
SATURN_R = 0.44  # Saturn's disc, as a fraction of the cell: small enough that the whole ring (2.05 radii out) stays inside the cell
RING_TILT = -0.32  # radians
RING_FLATTEN = 0.32
RING_INNER, RING_OUTER = (
    1.25,
    2.05,
)  # in planet radii (C ring edge to the A ring's edge: 1.24 to 2.27, trimmed to fit)
SUPERSAMPLE = 3


def _load(key):
    path = os.path.join(EARTH_DIR, MAP_FILE.get(key, key + "-v1.webp"))
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def _sphere(texture, radius_px, size, supersample):
    """RGBA float image `size` square: the map on a sphere of `radius_px`, lit; alpha is the disc's edge."""
    n = size * supersample
    c = (n - 1) / 2.0
    r = radius_px * supersample
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xs - c) / r
    y = (ys - c) / r
    d2 = x * x + y * y
    inside = d2 < 1.0
    z = np.sqrt(np.clip(1.0 - d2, 0.0, 1.0))
    lon = np.arctan2(
        x, z
    )  # straight over the equator, the map's centre toward the viewer
    lat = np.arcsin(np.clip(-y, -1.0, 1.0))
    h, w, _ = texture.shape
    u = (lon / (2 * math.pi) + 0.5) * (w - 1)
    v = (0.5 - lat / math.pi) * (h - 1)
    col = texture[
        np.clip(v.round().astype(int), 0, h - 1),
        np.clip(u.round().astype(int), 0, w - 1),
    ]
    ndl = x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]
    lit = np.clip((ndl + WRAP) / (1.0 + WRAP), 0.0, 1.0) ** 0.85
    limb = 0.72 + 0.28 * z**0.5
    rgb = col * (0.16 + 0.84 * lit)[..., None] * limb[..., None]
    edge = np.clip(
        (1.0 - np.sqrt(d2)) * r, 0.0, 1.0
    )  # a pixel of antialiasing at the rim
    alpha = np.where(inside, edge, 0.0)
    return np.dstack([np.clip(rgb, 0, 1), alpha])


def _downsample(img, k):
    n = img.shape[0] // k
    return img.reshape(n, k, n, k, img.shape[2]).mean(axis=(1, 3))


def _over(base, top):
    a = top[..., 3:4]
    ba = base[..., 3:4]
    oa = a + ba * (1 - a)
    rgb = (top[..., :3] * a + base[..., :3] * ba * (1 - a)) / np.maximum(oa, 1e-6)
    return np.dstack([rgb, oa])


def _rings(size, supersample, planet_r_px, front):
    """Saturn's rings as a tilted ellipse band; `front` is the half in front of the planet (below its centre line)."""
    n = size * supersample
    c = (n - 1) / 2.0
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xs - c) / (planet_r_px * supersample)
    y = (ys - c) / (planet_r_px * supersample)
    ct, st = math.cos(RING_TILT), math.sin(RING_TILT)
    u = x * ct + y * st
    v = (-x * st + y * ct) / RING_FLATTEN
    rr = np.sqrt(u * u + v * v)
    band = (rr > RING_INNER) & (rr < RING_OUTER)
    # B ring bright, Cassini division dark, A ring dimmer.
    t = (rr - RING_INNER) / (RING_OUTER - RING_INNER)
    shade = np.where(t < 0.45, 0.88, np.where(t < 0.55, 0.15, 0.62))
    side = (v > 0) if front else (v <= 0)
    alpha = np.where(band & side, shade * 0.95, 0.0)
    tone = np.array([0.86, 0.78, 0.6], dtype=np.float32)
    return np.dstack([np.broadcast_to(tone, (n, n, 3)), alpha])


SUN_R = 0.3  # the Sun's bright disc, as a fraction of the cell; the rest of the cell is its glow
SUN_CORE = np.array([1.0, 0.97, 0.82], dtype=np.float32)
SUN_RIM = np.array([1.0, 0.62, 0.16], dtype=np.float32)


def _sun(size, supersample):
    """The Sun: no map, a white-yellow disc going orange at the limb inside a soft glow."""
    n = size * supersample
    c = (n - 1) / 2.0
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    d = np.sqrt((xs - c) ** 2 + (ys - c) ** 2) / (
        size * supersample / 2
    )  # 0 at the centre, 1 at the cell's edge
    t = np.clip(d / SUN_R, 0, 1)
    disc_rgb = SUN_CORE * (1 - t[..., None] ** 2.2) + SUN_RIM * t[..., None] ** 2.2
    edge = np.clip((SUN_R - d) * size * supersample / 2, 0, 1)
    glow = np.clip(1 - d, 0, 1) ** 2.4 * 0.75
    rgb = disc_rgb * edge[..., None] + SUN_RIM * (1 - edge[..., None])
    alpha = np.maximum(edge, glow * (1 - edge))
    return np.dstack([rgb, alpha])


def disc(key):
    k = SUPERSAMPLE
    if key == "sun":
        return _downsample(_sun(CELL, k), k)
    tex = _load(key)
    if key == "saturn":
        r = CELL * SATURN_R / 2
        planet = _sphere(tex, r, CELL, k)
        back = _rings(CELL, k, r, front=False)
        front = _rings(CELL, k, r, front=True)
        # The rings' shadow on the planet is left out at this size.
        out = _over(_over(back, planet), front)
    else:
        out = _sphere(tex, CELL / 2 - 2, CELL, k)
    return _downsample(out, k)


def build():
    rows = math.ceil(len(KEYS) / COLUMNS)
    sheet = np.zeros((rows * CELL, COLUMNS * CELL, 4), dtype=np.float32)
    for i, key in enumerate(KEYS):
        r, c = divmod(i, COLUMNS)
        sheet[r * CELL : (r + 1) * CELL, c * CELL : (c + 1) * CELL] = disc(key)
    rgb = (
        sheet[..., :3] * sheet[..., 3:4]
    )  # premultiplied through the encoder, then unpremultiplied by alpha
    a = sheet[..., 3:4]
    rgb = np.where(a > 0, rgb / np.maximum(a, 1e-6), 0)
    arr = (np.dstack([np.clip(rgb, 0, 1), a]) * 255 + 0.5).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def main():
    img = build()
    if "--check" in sys.argv:
        import io

        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=QUALITY, method=6)
        have = open(OUT, "rb").read() if os.path.exists(OUT) else b""
        if buf.getvalue() != have:
            print("go-discs-v1.webp is stale: run scripts/build_go_discs.py")
            return 1
        return 0
    img.save(OUT, "WEBP", quality=QUALITY, method=6)
    print(
        "%s  %dx%d  %d bytes  keys=%s"
        % (OUT, img.width, img.height, os.path.getsize(OUT), ",".join(KEYS))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
