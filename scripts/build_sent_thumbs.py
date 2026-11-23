#!/usr/bin/env python3
"""Draw the Sent pill's little spacecraft: one sheet of renders, from the models the 3D view already ships.

python3 scripts/build_sent_thumbs.py --hd DIR    writes zimi/static/earth/sent-thumbs-v1.webp (DIR: the HD craft folder holding the craft that are not in the app)

Each model (a ZCR2 file, see scripts/craftmesh.py: the HD folder's <model>.zcr2, or craft-<model>-v1.bin; the older ZCRF files, craft-site-*
and craft-ms-*, are another layout and refused by name)
is drawn from three-quarters above and to the front-right, lit from the upper left, on a transparent ground, filling its
cell. The cells run left to right, top to bottom, over the models named in earth/sent-v1.json in sorted order (the order
almanac-sent.js works out the same way; tests/test_almanac_sent.py checks the sheet has room for them). A row whose model
is not named has the silhouette of its class instead.
"""

import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH_DIR = os.path.join(ROOT, "zimi", "static", "earth")
OUT = os.path.join(EARTH_DIR, "sent-thumbs-v1.webp")
CELL_PX = 128  # shown at 64 px: two device pixels each
COLS = 7
SUPER = 3  # drawn this many times larger, then averaged down
FILL = 0.94  # the model's fitted radius fills this share of the cell
FIT_PERCENTILE = 85
FIT_WIDE = set(  # a long array or boom is part of the picture: fit these to the whole craft, not the body's 85th percentile
    "clipper compton explorer1 lucy lunar-prospector magellan messenger mgs mro odyssey osirisrex psyche skylab "
    # the models scripts/build_sent_models.py writes (all of them have wings, dishes or antennas)
    "luna2 sputnik1 sputnik2 ranger lunar-orbiter venera4 vega mars3 phobos fobosgrunt mars96 salyut7 mex venusexpress tgo "
    "schiaparelli beagle2 solarorbiter juice smart1 change1 kaguya chandrayaan1 chandrayaan2o danuri hayabusa2 hope tianwen1 "
    "gaia vanguard1 gps hubble chandra tess fermi terra aqua tdrs hakuto beresheet peregrine luna25 tiangong uars pvo akatsuki marsobserver mco mpl ds2".split()
)
VIEW_AZ_DEG, VIEW_EL_DEG = 35.0, 28.0
LIGHT = np.array([-0.5, -0.35, 0.8])  # towards the light, in the view's frame (x right, y up, z towards the viewer)
AMBIENT = 0.3
GAIN = 1.3  # lit surfaces a little brighter: at 48 px a dark craft on a dark sheet is lost
RIM = 0.45  # the outline's colour, as a share of the surface's: what keeps a thin boom or panel readable


def models():
    with open(os.path.join(EARTH_DIR, "sent-v1.json"), encoding="utf-8") as f:
        return sorted({o["model"] for o in json.load(f)["objects"] if "model" in o})


HD_DIR = None  # the Almanac HD craft folder (--hd): the Sent chooser's craft that are not in the app live there as <key>.zcr2


def path_of(model):
    if HD_DIR and os.path.exists(os.path.join(HD_DIR, model + ".zcr2")):
        return os.path.join(HD_DIR, model + ".zcr2")
    for name in ("craft-%s-v1.bin", "craft-site-%s-v1.bin", "%s-v1.bin"):  # the last: the ISS
        p = os.path.join(EARTH_DIR, name % model)
        if os.path.exists(p):
            return p
    raise SystemExit("no model file for " + model)


def read_zcr2(path):
    """pos (n,3) units about the middle, nrm (n,3), cls (n,), tri (m,3), palette (k,3) linear rgb."""
    b = open(path, "rb").read()
    if b[:4] != b"ZCR2":
        raise SystemExit("%s: a %s file, not ZCR2; the sheet cannot draw this model" % (path, b[:4].decode("latin-1")))
    lo = np.array(struct.unpack_from("<3f", b, 12))
    hi = np.array(struct.unpack_from("<3f", b, 24))
    npal, nv, nt, flags = struct.unpack_from("<IIII", b, 60)
    o = 88
    pal = []
    for _ in range(npal):
        pal.append(struct.unpack_from("<3f", b, o))
        o += 24
    if flags & 2:
        (nn,) = struct.unpack_from("<H", b, o)
        o += 2
        for _ in range(nn):
            o += 1 + b[o]
    stride = 9 + (8 if flags & 1 else 0)
    raw = np.frombuffer(b, dtype=np.uint8, count=nv * stride, offset=o).reshape(nv, stride)
    o += nv * stride
    q = np.ascontiguousarray(raw[:, :6]).view("<i2").astype(np.float64).reshape(nv, 3)
    pos = lo + (q + 32767) / 65534 * (hi - lo)
    pos -= (lo + hi) / 2
    e = raw[:, 6:8].view("i1").astype(np.float64) / 127
    ez = 1 - np.abs(e[:, 0]) - np.abs(e[:, 1])
    x, y = e[:, 0].copy(), e[:, 1].copy()
    neg = ez < 0
    x[neg] = (1 - np.abs(e[neg, 1])) * np.where(e[neg, 0] >= 0, 1, -1)
    y[neg] = (1 - np.abs(e[neg, 0])) * np.where(e[neg, 1] >= 0, 1, -1)
    nrm = np.c_[x, y, ez]
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    dt = "<u4" if nv > 65535 else "<u2"
    tri = np.frombuffer(b, dtype=dt, count=nt * 3, offset=o).astype(np.int64).reshape(nt, 3)
    return pos, nrm, raw[:, 8].astype(np.int64), tri, np.array(pal)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def view_basis():
    az, el = math.radians(VIEW_AZ_DEG), math.radians(VIEW_EL_DEG)
    toward = np.array([math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)])  # from the model to the eye, z up
    right = np.cross([0, 0, 1], toward)
    right /= np.linalg.norm(right)
    up = np.cross(toward, right)
    return np.array([right, up, toward])


def render(model):
    pos, nrm, cls, tri, pal = read_zcr2(path_of(model))
    basis = view_basis()
    p = pos @ basis.T
    n = nrm @ basis.T
    r = np.percentile(np.linalg.norm(p, axis=1), 100 if model in FIT_WIDE else FIT_PERCENTILE)  # a long boom or antenna may leave the cell: the body is what shows
    size = CELL_PX * SUPER
    k = size / 2 * FILL / r
    sx, sy, sz = p[:, 0] * k + size / 2, size / 2 - p[:, 1] * k, p[:, 2]
    img = np.zeros((size, size, 4))
    zbuf = np.full((size, size), -1e30)
    light = LIGHT / np.linalg.norm(LIGHT)
    for t in tri:
        xs, ys, zs = sx[t], sy[t], sz[t]
        x0, x1 = int(max(0, math.floor(xs.min()))), int(min(size - 1, math.ceil(xs.max())))
        y0, y1 = int(max(0, math.floor(ys.min()))), int(min(size - 1, math.ceil(ys.max())))
        if x1 < x0 or y1 < y0:
            continue
        den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(den) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        a = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / den
        bb = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / den
        c = 1 - a - bb
        inside = (a >= 0) & (bb >= 0) & (c >= 0)
        if not inside.any():
            continue
        z = a * zs[0] + bb * zs[1] + c * zs[2]
        win = inside & (z > zbuf[y0 : y1 + 1, x0 : x1 + 1])
        if not win.any():
            continue
        nn = n[t].mean(axis=0)
        if nn @ np.array([0, 0, 1.0]) < 0:  # a face seen from behind is lit as the side we see
            nn = -nn
        nn /= max(np.linalg.norm(nn), 1e-9)
        shade = AMBIENT + (1 - AMBIENT) * max(0.0, float(nn @ light))
        col = srgb(pal[cls[t[0]]] * 1.0) * min(1.0, shade * GAIN)
        sub = zbuf[y0 : y1 + 1, x0 : x1 + 1]
        sub[win] = z[win]
        img[y0 : y1 + 1, x0 : x1 + 1][win] = [col[0], col[1], col[2], 1.0]
    solid = img[:, :, 3] > 0.5
    edge = solid & ~(np.roll(solid, 1, 0) & np.roll(solid, -1, 0) & np.roll(solid, 1, 1) & np.roll(solid, -1, 1))
    img[edge, :3] *= RIM
    rgb = (img[:, :, :3] * img[:, :, 3:4]).reshape(CELL_PX, SUPER, CELL_PX, SUPER, 3).mean(axis=(1, 3))
    alpha = img[:, :, 3].reshape(CELL_PX, SUPER, CELL_PX, SUPER).mean(axis=(1, 3))
    rgb = rgb / np.maximum(alpha[:, :, None], 1e-6)
    return np.dstack([np.clip(rgb, 0, 1) * 255, alpha * 255]).astype(np.uint8)


def main():
    global HD_DIR
    if "--hd" in sys.argv:
        HD_DIR = sys.argv[sys.argv.index("--hd") + 1]
    ms = models()
    rows = -(-len(ms) // COLS)
    sheet = Image.new("RGBA", (COLS * CELL_PX, rows * CELL_PX), (0, 0, 0, 0))
    for i, m in enumerate(ms):
        print(i, m, file=sys.stderr)
        sheet.paste(Image.fromarray(render(m), "RGBA"), ((i % COLS) * CELL_PX, (i // COLS) * CELL_PX))
    sheet.save(OUT, "WEBP", quality=76, method=6)
    print(OUT, os.path.getsize(OUT), "bytes", len(ms), "models")


if __name__ == "__main__":
    main()
