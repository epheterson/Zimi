#!/usr/bin/env python3
"""Draw the Go to sheet's little bodies: one sprite sheet of lit discs, from the base maps the 3D view already ships.

python3 scripts/build_go_discs.py            writes zimi/static/earth/go-discs-v2.webp and go-maps-v1.webp
python3 scripts/build_go_discs.py --check    fails if the files are not what this script makes (needs the same Pillow)

go-maps-v1.webp is the 3D view's row's own: each world's map, small (MAP_W by MAP_W / 2, equirectangular) and brought to the same exposure, for
the row to light and turn as the world is at the shown moment (almanac-earth.js _aeRowLitPaint). Its order is AE_ROW_MAP_KEYS'.

Each body is its equirectangular map on a sphere lit from the Sun's side (the left, where the Sun stands at the row's start), seen gibbous so the
terminator shows down its right edge; every face is brought to one exposure first so they read equally bright. The Earth is turned to the Americas.
The light falls off the way each kind of world's does (Minnaert: airless rock stays bright to its limb, cloud decks darken toward it), and a world
with air carries its air as a thin lit rim: the Earth blue, Venus pale, Titan orange, Mars faint. The Earth's sea shows the Sun's glint.
Saturn carries its rings across its face and the Sun is a ball too. No texture is added for this: every pixel comes from a map under zimi/static/earth/. The order below is the order of AE_GO_DISC_KEYS in almanac-earth.js
(tests/test_almanac_go_sheet_browser.py checks they agree).
"""

import math
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH_DIR = os.path.join(ROOT, "zimi", "static", "earth")
OUT = os.path.join(EARTH_DIR, "go-discs-v2.webp")
OUT_MAPS = os.path.join(EARTH_DIR, "go-maps-v1.webp")
# The worlds the row shows: the planets, the Moon and the moons that stand beside their planet (not Charon: Pluto has no place in the row).
MAP_KEYS = ["earth", "moon", "mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "io", "europa", "ganymede", "callisto", "titan",
            "mimas", "enceladus", "tethys", "dione", "rhea", "iapetus", "triton", "phobos"]
MAP_W = 256  # a map's width (its height is half): about the row's 40 px disc at 3x across its middle
MAP_COLS = 4
MAP_QUALITY = 80

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
CELL = 120  # pixels a disc is drawn at (the row's 40 CSS px at 3x)
COLUMNS = 7
QUALITY = 80
# Toward the Sun: from the left (the Sun leads the row), a little above, and toward the viewer: a phase angle of about 50 degrees, so each ball is
# gibbous with its terminator down the right edge.
LIGHT = np.array([-0.72, -0.22, 0.66])
LIGHT = LIGHT / np.linalg.norm(LIGHT)
AMBIENT = 0.07  # the night side: dim, as by the light of what it faces, so the ball still reads whole against the black
# Minnaert's limb exponent per kind of surface: 0.5 is airless regolith (Lommel-Seeliger: bright to the limb, the Moon's flat full face), 1 is Lambert.
MINNAERT = {"earth": 0.8, "venus": 0.9, "mars": 0.65, "jupiter": 0.9, "saturn": 0.9, "uranus": 0.95, "neptune": 0.95, "titan": 0.95}
MINNAERT_ROCK = 0.55
# Air seen edge-on: the colour of the lit limb and how strongly it shows there.
AIR = {
    "earth": ((0.42, 0.66, 1.0), 0.75),
    "venus": ((1.0, 0.96, 0.86), 0.55),
    "titan": ((1.0, 0.7, 0.35), 0.6),
    "mars": ((0.85, 0.82, 0.95), 0.22),
    "jupiter": ((0.95, 0.9, 0.82), 0.18),
    "saturn": ((0.95, 0.9, 0.78), 0.18),
    "uranus": ((0.75, 0.95, 1.0), 0.25),
    "neptune": ((0.55, 0.7, 1.0), 0.25),
}
AIR_WIDTH = 4.0  # how sharply the air falls off from the limb (higher: thinner)
GLINT = {"earth": (0.35, 80.0)}  # the Sun on water: strength and Phong exponent (sea only)
RING_TILT = -0.32  # radians
RING_FLATTEN = 0.32
RING_INNER, RING_OUTER = (
    1.25,
    2.05,
)  # in planet radii (C ring edge to the A ring's edge: 1.24 to 2.27, trimmed to fit)
SUPERSAMPLE = 3
EXPOSURE = 0.5  # the mean brightness every face is brought to (0 to 1)
MAX_GAIN = 3.2
VIEW = {"earth": (-85.0, 12.0)}  # where each ball is turned to look: the Americas side of the Earth (lon, lat in degrees)


def _load(key):
    path = os.path.join(EARTH_DIR, MAP_FILE.get(key, key + "-v1.webp"))
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def _sphere(key, texture, radius_px, size, supersample, lon0=0.0, lat0=0.0):
    """RGBA float image `size` square: the map on a sphere of `radius_px` lit from LIGHT, the point (lon0, lat0) in degrees at its middle;
    alpha is the disc's edge."""
    n = size * supersample
    c = (n - 1) / 2.0
    r = radius_px * supersample
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xs - c) / r
    y = (ys - c) / r
    d2 = x * x + y * y
    inside = d2 < 1.0
    z = np.sqrt(np.clip(1.0 - d2, 0.0, 1.0))
    la = math.radians(lat0)
    up = -y
    up2 = up * math.cos(la) - z * math.sin(la)  # the view turned to look at latitude lat0
    z2 = up * math.sin(la) + z * math.cos(la)
    lon = np.arctan2(x, z2) + math.radians(lon0)  # straight over the equator, the map's centre toward the viewer
    lat = np.arcsin(np.clip(up2, -1.0, 1.0))
    h, w, _ = texture.shape
    u = ((lon / (2 * math.pi) + 0.5) % 1.0) * (w - 1)
    v = (0.5 - lat / math.pi) * (h - 1)
    col = texture[
        np.clip(v.round().astype(int), 0, h - 1),
        np.clip(u.round().astype(int), 0, w - 1),
    ]
    # One exposure for every ball: the face's mean albedo is brought to EXPOSURE (a mostly-ocean Earth needs a lift, a bright Venus none).
    mean = float(col[inside].mean()) if inside.any() else EXPOSURE
    col = np.clip(col * min(MAX_GAIN, EXPOSURE / max(mean, 1e-3)), 0, 1)
    mu = np.maximum(z, 1e-4)  # toward the viewer
    mu0 = np.clip(x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2], 0.0, 1.0)  # toward the Sun
    k = MINNAERT.get(key, MINNAERT_ROCK)
    lit = mu0**k * mu ** (k - 1.0)
    lit = np.clip(lit / LIGHT[2] ** (k - 1.0), 0.0, 1.2)  # the subsolar point at its albedo; airless rock's limb a touch brighter
    rgb = col * (AMBIENT + (1 - AMBIENT) * lit)[..., None]
    if key in GLINT:
        amount, power = GLINT[key]
        sea = np.clip((col[..., 2] - np.maximum(col[..., 0], col[..., 1])) * 4.0, 0.0, 1.0)  # blue over green and red: water
        half = LIGHT + np.array([0.0, 0.0, 1.0])
        half = half / np.linalg.norm(half)
        spec = np.clip(x * half[0] + y * half[1] + z * half[2], 0.0, 1.0) ** power
        rgb = rgb + (amount * spec * sea * (mu0 > 0))[..., None]
    if key in AIR:
        tint, amount = AIR[key]
        rim = np.exp(-AIR_WIDTH * z) * np.clip(mu0 * 2.5 + 0.15, 0.0, 1.0) ** 0.8  # thickest seen edge-on, lit only where the Sun reaches
        a = (amount * rim)[..., None]
        rgb = rgb * (1 - a) + np.array(tint, dtype=np.float32) * a
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


SUN_CORE = np.array([1.0, 0.95, 0.74], dtype=np.float32)
SUN_RIM = np.array([1.0, 0.52, 0.12], dtype=np.float32)
SUN_GRAIN = 0.045  # how much the photosphere's granulation varies the colour


def _sun(size, supersample):
    """The Sun as a ball like every other cell: a yellow-white face going orange at the limb, with a fine granulation."""
    n = size * supersample
    c = (n - 1) / 2.0
    r = (size / 2 - 2) * supersample
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    d = np.sqrt((xs - c) ** 2 + (ys - c) ** 2) / r  # 0 at the centre, 1 at the limb
    inside = d < 1.0
    z = np.sqrt(np.clip(1.0 - d * d, 0.0, 1.0))
    limb = (1 - z[..., None]) ** 1.6  # limb darkening: the edge is cooler, so more orange
    rgb = SUN_CORE * (1 - limb) + SUN_RIM * limb
    rng = np.random.default_rng(5)
    cells = rng.random((size // 3, size // 3)).astype(np.float32)
    grain = np.kron(cells, np.ones((3 * supersample, 3 * supersample), dtype=np.float32))[:n, :n]
    rgb = rgb * (1 - SUN_GRAIN + 2 * SUN_GRAIN * grain)[..., None]
    edge = np.clip((1.0 - d) * r, 0.0, 1.0)
    return np.dstack([np.clip(rgb, 0, 1), np.where(inside, edge, 0.0)])


def disc(key):
    k = SUPERSAMPLE
    if key == "sun":
        return _downsample(_sun(CELL, k), k)
    tex = _load(key)
    if key == "saturn":
        r = (CELL / 2 - 3) / RING_OUTER  # the whole ringed planet inside the disc: a smaller ball, its rings out to the edge (a ball as big as the others had its rings cut off by the round edge)
        planet = _sphere(key, tex, r, CELL, k, *VIEW.get(key, (0.0, 0.0)))
        back = _rings(CELL, k, r, front=False)
        front = _rings(CELL, k, r, front=True)
        # The rings' shadow on the planet is left out at this size.
        out = _over(_over(back, planet), front)
    else:
        out = _sphere(key, tex, CELL / 2 - 2, CELL, k, *VIEW.get(key, (0.0, 0.0)))
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


def build_maps():
    """Every MAP_KEYS map at MAP_W, its area-weighted mean brightness brought to EXPOSURE (as each ball's face is above)."""
    h = MAP_W // 2
    rows = math.ceil(len(MAP_KEYS) / MAP_COLS)
    sheet = np.zeros((rows * h, MAP_COLS * MAP_W, 3), dtype=np.float32)
    weight = np.cos((0.5 - (np.arange(h) + 0.5) / h) * math.pi)[:, None, None]  # a row's share of the sphere
    for i, key in enumerate(MAP_KEYS):
        path = os.path.join(EARTH_DIR, MAP_FILE.get(key, key + "-v1.webp"))
        m = np.asarray(Image.open(path).convert("RGB").resize((MAP_W, h), Image.LANCZOS), dtype=np.float32) / 255.0
        mean = float((m * weight).sum() / (weight.sum() * MAP_W * 3))
        m = np.clip(m * min(MAX_GAIN, EXPOSURE / max(mean, 1e-3)), 0, 1)
        r, c = divmod(i, MAP_COLS)
        sheet[r * h : (r + 1) * h, c * MAP_W : (c + 1) * MAP_W] = m
    return Image.fromarray((sheet * 255 + 0.5).astype(np.uint8), "RGB")


def main():
    import io

    outs = [(OUT, build(), QUALITY), (OUT_MAPS, build_maps(), MAP_QUALITY)]
    stale = 0
    for path, img, quality in outs:
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=quality, method=6)
        if "--check" in sys.argv:
            have = open(path, "rb").read() if os.path.exists(path) else b""
            if buf.getvalue() != have:
                print("%s is stale: run scripts/build_go_discs.py" % os.path.basename(path))
                stale = 1
            continue
        with open(path, "wb") as f:
            f.write(buf.getvalue())
        print("%s  %dx%d  %d bytes" % (path, img.width, img.height, os.path.getsize(path)))
    return stale


if __name__ == "__main__":
    sys.exit(main())
