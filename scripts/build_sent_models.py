"""Build the Sent chooser's spacecraft that NASA's 3D library has no model of: reconstructions written for Zimi from
each craft's published dimensions and photographs (no third-party geometry), in the same format as the NASA ones.

    python scripts/build_sent_models.py --hd DIR [--only luna2,ranger]

Each is <key>.zcr2 in the Almanac HD pack's craft folder (hd/craft/, with its index.json row; ZCR2, metres, z up). The craft faces -y (its dish or its camera), its
wings run along x, so the Sent sheet's three-quarter view sees the face and the wings. These are honest reconstructions:
the main bodies, arrays, dishes, booms and legs at their published sizes, no surface detail a photograph does not show.
The sizes and sources of each are in the function's docstring and in earth/SOURCES.txt.
"""

import argparse
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_site_models as bsm  # noqa: E402
import craftmesh as cm  # noqa: E402

EARTH = bsm.EARTH
# the palette every model draws from (colour, specular strength, sharpness: build_site_models' entries)
PAL = [
    bsm.ALU,
    bsm.GOLD,
    bsm.WHITE,
    bsm.DARK,
    bsm.PANEL,
    bsm.GREY,
    bsm.BLACK,
    bsm.RED,
    bsm.BLUE,
    ((0.62, 0.3, 0.1), 0.2, 14),
    ((0.75, 0.74, 0.7), 0.4, 25),
]
ALU, GOLD, WHITE, DARK, CELLS, GREY, BLACK, RED, BLUE, ORANGE, STEEL = range(11)
FRONT = (0, -1, 0)


GRID = len(PAL)  # a silver line: the busbars between cells, a panel's frame
PAL.append(((0.62, 0.64, 0.72), 0.3, 40))
# what the viewer draws procedurally on each palette entry (cm.KIND_*): gold foil, cell grids, blankets, bare metal
KIND_OF = {GOLD: cm.KIND_FOIL, CELLS: cm.KIND_CELLS, WHITE: cm.KIND_QUILT, ALU: cm.KIND_METAL, GRID: cm.KIND_METAL}


class Craft(bsm.Mesh):
    def __init__(self):
        super().__init__(PAL)

    # ── solar arrays ──
    def wing(self, x0, x1, chord, y=0.0, z=0.0, segs=1, color=CELLS, thick=0.04, gap=0.03, frame=ALU, cell=0.11):
        """A solar wing from x0 to x1 (either sign), `chord` tall, in `segs` panels with a gap between, each in a frame, its
        cells a grid of busbars about `cell` metres apart, the yoke down the root and a hinge between the panels."""
        lo, hi = min(x0, x1), max(x0, x1)
        w = (hi - lo - gap * (segs - 1)) / segs
        rim = min(0.05, 0.04 * chord)
        fy = y - thick / 2 - 0.004
        for i in range(segs):
            a = lo + i * (w + gap)
            cx = a + w / 2
            self.box((cx, y, z), (w, thick, chord), frame)
            self.box((cx, fy + 0.002, z), (w - 2 * rim, 0.008, chord - 2 * rim), color)
            ncol = max(2, min(14, int(round((w - 2 * rim) / (cell * 4)))))
            nrow = max(2, min(10, int(round((chord - 2 * rim) / (cell * 4)))))
            for k in range(1, ncol):
                x = a + rim + (w - 2 * rim) * k / ncol
                self.box((x, fy - 0.003, z), (0.012, 0.004, chord - 2 * rim), GRID)
            for k in range(1, nrow):
                zz = z - (chord - 2 * rim) / 2 + (chord - 2 * rim) * k / nrow
                self.box((cx, fy - 0.003, zz), (w - 2 * rim, 0.004, 0.012), GRID)
            if i:
                self.box((a - gap / 2, y, z), (gap * 1.4, thick * 1.5, chord * 0.12), frame)
        self.tube((lo, y + thick, z), (hi, y + thick, z), 0.02, frame, n=6)
        yoke = lo if abs(lo) < abs(hi) else hi
        self.box((yoke, y + thick * 2, z), (0.08, 0.1, chord * 0.28), DARK)

    def flatpanel(self, c, lx, ly, rotz=0.0, color=CELLS, cell=0.11, thick=0.03):
        """A solar panel lying flat (normal +z): framed, its cells a grid of busbars on top."""
        cx, cy, cz = c
        co, si = math.cos(rotz), math.sin(rotz)
        put = lambda dx, dy, dz, size, col: self.box((cx + dx * co - dy * si, cy + dx * si + dy * co, cz + dz), size, col, rotz=rotz)
        rim = min(0.04, 0.05 * min(lx, ly))
        put(0, 0, 0, (lx, ly, thick), ALU)
        put(0, 0, thick / 2 + 0.002, (lx - 2 * rim, ly - 2 * rim, 0.006), color)
        for k in range(1, max(2, min(12, int(lx / (cell * 4))))):
            put(-lx / 2 + rim + (lx - 2 * rim) * k / max(2, min(12, int(lx / (cell * 4)))), 0, thick / 2 + 0.006, (0.01, ly - 2 * rim, 0.004), GRID)
        for k in range(1, max(2, min(8, int(ly / (cell * 4))))):
            put(0, -ly / 2 + rim + (ly - 2 * rim) * k / max(2, min(8, int(ly / (cell * 4)))), thick / 2 + 0.006, (lx - 2 * rim, 0.01, 0.004), GRID)

    # ── dishes ──
    def hdish(self, c, r, color=WHITE, depth=0.22, n=20):
        """A dish looking -y: a paraboloid with a rim, on a gimbal and a mast, the feed horn held out on three struts."""
        c = np.asarray(c, float)
        self.parabola(c, r, depth, color, n=n)
        self.tube(c, c + (0, 0.45 * r, 0), 0.03 * max(r, 0.5), ALU, n=6)
        self.box(c + (0, 0.22 * r, 0), (0.18 * r, 0.14 * r, 0.12 * r), DARK)
        f = c + (0, -(r * depth * 2.2 + 0.1 * r), 0)
        for k in range(3):
            a = math.radians(90 + 120 * k)
            self.tube(c + (0.92 * r * math.cos(a), -0.02 * r, 0.92 * r * math.sin(a)), f, 0.008 * max(r, 0.5), ALU, n=4)
        self.frustum(f + (0, 0.04 * r, 0), f + (0, -0.08 * r, 0), 0.04 * r, 0.09 * r, GOLD, n=10)

    def parabola(self, c, r, depth, color, n=20, rings=5):
        """A dish: a paraboloid opening toward -y, its apex at c and its rim r wide, `depth` times r deep, with a rim ring."""
        v, f = [], []
        for i in range(rings + 1):
            t = i / rings
            for j in range(n):
                a = 2 * math.pi * j / n
                v.append([r * t * math.cos(a), depth * r * (1 - t * t), r * t * math.sin(a)])
        for i in range(rings):
            for j in range(n):
                a, b = i * n + j, i * n + (j + 1) % n
                f += [(a, b, b + n), (a, b + n, a + n)]
        v = np.array(v) + np.asarray(c)
        v[:, 1] = c[1] - (v[:, 1] - c[1])  # the bowl opens toward -y (the viewer)
        self.add(v, f, color)
        self.frustum(np.asarray(c) + (0, -depth * r * 0, 0), np.asarray(c) + (0, -depth * r, 0), r * 0.98, r, GRID, n=n, caps=False)

    # ── bodies ──
    def block(self, c, size, color=GOLD, trim=ALU, detail=True):
        """A box bus: wrapped in blanket (colour), its four vertical edges and its front trimmed, a radiator and a star tracker on it,
        thruster pods on the back corners."""
        sx, sy, sz = size
        self.box(c, size, color)
        e = 0.018 * min(size)
        for ix in (-1, 1):
            for iz in (-1, 1):
                self.box((c[0] + ix * sx / 2, c[1], c[2] + iz * sz / 2), (e, sy * 1.002, e), trim)
        for iy in (-1, 1):
            for iz in (-1, 1):
                self.box((c[0], c[1] + iy * sy / 2, c[2] + iz * sz / 2), (sx * 1.002, e, e), trim)
            for ix in (-1, 1):
                self.box((c[0] + ix * sx / 2, c[1] + iy * sy / 2, c[2]), (e, e, sz * 1.002), trim)
        if not detail:
            return
        self.box((c[0], c[1] - sy / 2 - 0.004, c[2] + sz * 0.3), (sx * 0.72, 0.012, sz * 0.22), WHITE)  # a radiator panel
        for k in range(1, 5):
            self.box((c[0] - sx * 0.36 + sx * 0.72 * k / 5, c[1] - sy / 2 - 0.012, c[2] + sz * 0.3), (0.008, 0.008, sz * 0.22), trim)
        self.cyl((c[0] - sx * 0.3, c[1] - sy / 2 - 0.06, c[2] - sz * 0.25), 0.07 * min(sx, sz), 0.12, DARK, n=10, axis="y")  # a star tracker
        self.cyl((c[0] + sx * 0.3, c[1] - sy / 2 - 0.05, c[2] - sz * 0.3), 0.045 * min(sx, sz), 0.1, GREY, n=8, axis="y")
        for ix in (-1, 1):
            self.frustum((c[0] + ix * sx * 0.4, c[1] + sy / 2, c[2] - sz * 0.42), (c[0] + ix * sx * 0.4, c[1] + sy / 2 + 0.16, c[2] - sz * 0.42), 0.02 * min(sx, sz), 0.05 * min(sx, sz), GREY, n=8)

    def tank(self, c, r, color=STEEL):
        self.sphere(c, r, color, nlat=7, nlon=12)

    def instrument(self, c, r, ln, axis="y", color=DARK, ring=GREY):
        """A camera or sensor barrel with a bezel and a dark aperture."""
        self.cyl(c, r, ln, color, n=12, axis=axis)
        d = {"x": (1, 0, 0), "y": (0, -1, 0), "z": (0, 0, 1)}[axis]
        p = np.asarray(c, float) + np.array(d) * ln / 2
        self.frustum(p, p + np.array(d) * 0.03 * ln, r * 1.15, r * 1.15, ring, n=12)
        self.frustum(p + np.array(d) * 0.03 * ln, p + np.array(d) * 0.05 * ln, r * 0.8, r * 0.8, BLACK, n=12)

    def legs(self, n, r0, z0, r1, z1, rad=0.05, pad=0.18, start=45, color=ALU):
        """Landing legs: a main strut and a shorter brace to each footpad, a crush barrel on the strut."""
        for k in range(n):
            a = math.radians(start + 360 * k / n)
            ca, sa = math.cos(a), math.sin(a)
            self.tube((r0 * ca, r0 * sa, z0), (r1 * ca, r1 * sa, z1), rad, color)
            mid = (r0 + (r1 - r0) * 0.55, z0 + (z1 - z0) * 0.55)
            self.tube((r0 * 0.35 * ca, r0 * 0.35 * sa, z0 - 0.15 * (z0 - z1)), (mid[0] * ca, mid[0] * sa, mid[1]), rad * 0.55, color)
            self.cyl(((r0 + (r1 - r0) * 0.3) * ca, (r0 + (r1 - r0) * 0.3) * sa, z0 + (z1 - z0) * 0.3), rad * 1.6, abs(z1 - z0) * 0.25, GREY, n=8)
            self.frustum((r1 * ca, r1 * sa, z1 + 0.04), (r1 * ca, r1 * sa, z1 - 0.01), pad * 0.4, pad, color, n=10)

    def write(self, key):
        v = np.vstack(self.v)
        f = np.vstack(self.f)
        cls = np.concatenate(self.c)
        v = v - (v.min(0) + v.max(0)) / 2
        v, f, n, src = cm.creased(v, f, bsm.SITE_CREASE_DEG, return_index=True)
        cls = cls[src]
        lo, hi = v.min(0), v.max(0)
        looks = [bsm._flat_look(*e) + (KIND_OF.get(i, cm.KIND_NONE),) for i, e in enumerate(self.palette)]
        data = cm.pack(1.0, lo, hi, FRONT, (1, 0, 0), looks, v, n, cls, f)
        cm.hd_add(OUT, key, data, CREDIT)
        print(
            "  %-18s %6d triangles %5.1f x %5.1f x %5.1f m  %5.1f KB"
            % (key, len(f), *(hi - lo), len(data) / 1024)
        )


OUT = None  # the Almanac HD craft folder (--hd)
CREDIT = "Reconstruction written for Zimi from published dimensions"


def _round_lander(m, r, h, z0, legs=4, leg_r=1.2, foot=0.2):
    m.cyl((0, 0, z0 + h / 2), r, h, GOLD, n=12)
    m.legs(legs, r * 0.8, z0 + h * 0.3, leg_r, z0 - 0.5 * h, pad=foot)


def skylab():
    """Skylab (1973): the 6.7 m, 14.7 m Orbital Workshop, the airlock and docking adapter (3.05 m) with the Apollo spacecraft, the
    Apollo Telescope Mount's four 'windmill' arrays beside them (30 m across), and, as it flew after launch, one workshop wing
    and the gold parasol sunshade."""
    m = Craft()
    m.frustum((-14.0, 0, 0), (-7.3, 0, 0), 3.35, 3.35, WHITE, n=24)
    m.frustum((-7.3, 0, 0), (-5.9, 0, 0), 3.35, 1.55, WHITE, n=24)
    m.frustum((-5.9, 0, 0), (0.0, 0, 0), 1.55, 1.55, STEEL, n=20)
    m.frustum((0.0, 0, 0), (3.6, 0, 0), 1.55, 1.55, GREY, n=20)
    m.frustum((3.6, 0, 0), (4.6, 0, 0), 1.55, 0.7, ALU, n=16)
    m.frustum((4.6, 0, 0), (8.3, 0, 0), 1.9, 1.9, WHITE, n=16)
    m.frustum((8.3, 0, 0), (10.8, 0, 0), 1.9, 0.4, ALU, n=16)
    m.box((-14.2, 0, 0), (0.25, 5.0, 5.0), DARK)
    # the ATM, held above the docking adapter, with its four arrays in a windmill (their plane is square to the Sun line)
    m.cyl((-1.5, 0, 3.3), 1.2, 2.2, ALU, n=8)
    m.cyl((-1.5, 0, 4.6), 0.5, 0.5, GOLD, n=8, axis="z")
    for k in range(4):
        a = math.radians(45 + 90 * k)
        c = (-1.5 + 5.3 * math.cos(a), 5.3 * math.sin(a), 4.9)
        m.flatpanel(c, 7.4, 2.3, rotz=a, cell=0.3)
    # the surviving workshop wing and the parasol over the workshop's sunward side
    m.flatpanel((-8.0, 6.2, -3.0), 8.2, 6.0, cell=0.3)
    m.tube((-12.0, 3.4, -3.0), (-4.0, 3.4, -3.0), 0.1, ALU, n=4)
    m.box((-8.5, 0.0, 3.75), (13.0, 7.4, 0.06), GOLD)
    return m


# ── Soviet ──
def luna2():
    """Luna 2 (Ye-1A, 1959): a 390 kg sphere about 0.95 m across with five rod antennas and a cylindrical instrument case."""
    m = Craft()
    m.sphere((0, 0, 0), 0.48, ALU, nlat=12, nlon=20)
    m.frustum((0, 0, -0.02), (0, 0, 0.02), 0.485, 0.485, GRID, n=20, caps=False)
    for k in range(8):
        a = math.radians(45 * k + 22)
        m.cyl((0.46 * math.cos(a), 0.46 * math.sin(a), -0.15), 0.035, 0.05, DARK, n=8, axis='x')
    m.cyl((0, 0, -0.62), 0.55, 0.5, STEEL, n=16)
    for z in (-0.5, -0.74):
        m.frustum((0, 0, z), (0, 0, z + 0.03), 0.56, 0.56, GRID, n=16, caps=False)
    m.frustum((0, 0, 0.45), (0, 0, 1.4), 0.04, 0.012, ALU, n=6)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        m.tube(
            (0.4 * math.cos(a), 0.4 * math.sin(a), 0.2),
            (1.0 * math.cos(a), 1.0 * math.sin(a), 0.62),
            0.012,
            ALU,
            n=4,
        )
    return m


def sputnik1():
    """Sputnik 1 (1957): a polished sphere 58 cm across, four whip antennas 2.4 and 2.9 m swept back from it."""
    m = Craft()
    m.sphere((0, 0, 0), 0.29, STEEL, nlat=12, nlon=20)
    for k, ln in zip(range(4), (2.4, 2.9, 2.4, 2.9)):
        a = math.radians(45 + 90 * k)
        d = (math.cos(a) * 0.35, math.sin(a) * 0.35, -0.93)
        n = math.sqrt(sum(x * x for x in d))
        m.tube(
            (0.26 * math.cos(a), 0.26 * math.sin(a), -0.08),
            tuple(
                np.array((0.26 * math.cos(a), 0.26 * math.sin(a), -0.08))
                + np.array(d) / n * ln
            ),
            0.007,
            ALU,
            n=4,
        )
    return m


def sputnik2():
    """Sputnik 2 (1957): the last stage's conical shell, about 4 m long, with the sphere-nosed instrument case and the dog's cabin."""
    m = Craft()
    m.frustum((0, 0, -2.0), (0, 0, 1.7), 0.95, 0.32, STEEL, n=20)
    m.cyl((0, 0, -2.0), 0.97, 0.16, ALU, n=20)
    m.sphere((0, 0, 1.78), 0.3, ALU, nlat=8, nlon=14)
    m.cyl((0.6, 0, -0.4), 0.28, 0.8, GREY, n=10)
    for s in (-1, 1):
        m.tube((0.2 * s, 0, 1.8), (1.4 * s, 0.3, 1.4), 0.01, ALU, n=4)
    return m


def ranger():
    """Ranger 4 and 7 to 9 (1962-65): the hexagonal base 1.5 m across, the 2.5 m tower, the camera cone on top, the 1.2 m dish
    and two 1.5 by 0.74 m panel pairs (5 m across)."""
    m = Craft()
    m.cyl((0, 0, 0), 0.78, 0.35, GOLD, n=6)
    for k in range(6):
        a = math.radians(60 * k)
        m.tube(
            (0.55 * math.cos(a), 0.55 * math.sin(a), 0.15),
            (0.2 * math.cos(a), 0.2 * math.sin(a), 2.6),
            0.03,
            ALU,
            n=4,
        )
    for z in (0.9, 1.7):
        m.frustum(
            (0, 0, z),
            (0, 0, z + 0.04),
            0.5 - 0.17 * z / 1.7,
            0.5 - 0.17 * z / 1.7,
            ALU,
            n=6,
        )
    m.frustum((0, 0, 2.5), (0, 0, 3.0), 0.3, 0.2, WHITE, n=10)
    m.box((0, -0.2, 3.15), (0.3, 0.3, 0.3), DARK)
    m.box((0.2, 0.15, 3.2), (0.18, 0.18, 0.22), BLACK)
    m.tube((0, 0, 3.3), (0, 0, 4.6), 0.02, ALU, n=4)
    m.dish((0, -0.35, 0.35), 0.62, (0, -0.6, 0.8), WHITE, depth=0.25)
    m.tube((0, -0.1, 0.2), (0, -0.35, 0.35), 0.03, ALU, n=4)
    for s in (-1, 1):
        m.wing(s * 0.8, s * 3.3, 0.74, y=0.0, z=0.5, segs=2)
        m.wing(s * 0.8, s * 3.3, 0.74, y=0.0, z=-0.3, segs=2)
    return m


def lunar_orbiter():
    """Lunar Orbiters 1, 2, 3 and 5 (1966-67): the 1.65 m base cone and the camera and film deck, four panels 3.7 m across,
    the 0.9 m dish on a boom and the omni mast."""
    m = Craft()
    m.frustum((0, 0, 0), (0, 0, 0.9), 0.82, 0.55, GOLD, n=16)
    m.cyl((0, 0, 1.12), 0.55, 0.4, WHITE, n=16)
    m.cyl((0, 0, 1.4), 0.42, 0.22, DARK, n=12)
    m.frustum((0, 0, -0.35), (0, 0, 0.0), 0.3, 0.82, ALU, n=16)
    m.tube((0, 0, 1.5), (0, 0, 2.7), 0.02, ALU, n=4)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        ca, sa = math.cos(a), math.sin(a)
        (
            m.box((1.85 * ca, 1.85 * sa, 0.5), (1.7 if ca else 0, 0.0, 0.0), CELLS)
            if False
            else None
        )
        m.flatpanel((1.45 * ca, 1.45 * sa, 0.45), 1.5, 0.95, rotz=a)
        m.tube((0.6 * ca, 0.6 * sa, 0.45), (2.1 * ca, 2.1 * sa, 0.45), 0.015, ALU, n=4)
    m.tube((0.5, -0.5, 0.2), (1.3, -1.4, 1.5), 0.02, ALU, n=4)
    m.dish((1.3, -1.4, 1.5), 0.45, (0.4, -0.7, 0.4), WHITE, depth=0.3)
    return m


def venera4():
    """Venera 4, 5 and 6 (1967-69): the 1 m cylinder bus with its two 2.4 m panels and the 2.3 m dish, and the 1 m sphere that
    went down on the parachute."""
    m = Craft()
    m.cyl((0, 0, 0), 0.55, 1.9, ALU, n=18)
    m.cyl((0, 0, 0.95), 0.58, 0.12, GOLD, n=18)
    m.sphere((0, 0, 1.55), 0.5, STEEL, nlat=10, nlon=16)
    m.cyl((0, 0, 1.12), 0.35, 0.2, DARK, n=12)
    m.wing(0.6, 3.0, 1.9, y=0.0, z=-0.05, segs=1)
    m.wing(-0.6, -3.0, 1.9, y=0.0, z=-0.05, segs=1)
    m.dish((0, -1.5, -0.7), 1.15, (0, -0.5, 0.15), WHITE, depth=0.25, n=20)
    m.tube((0, -0.4, -0.5), (0, -1.5, -0.7), 0.03, ALU, n=4)
    m.tube((0.3, 0.3, -0.95), (0.3, 0.3, -1.6), 0.02, ALU, n=4)
    return m


def vega():
    """Vega 1 and 2 (1985): the Venera bus (4.5 m, 4 m dish) with its descent module and balloon above, the dust-shielded
    scan platform below, and two 10 m panels."""
    m = Craft()
    m.cyl((0, 0, 0), 0.8, 2.4, WHITE, n=20)
    m.cyl((0, 0, 1.25), 0.85, 0.15, GOLD, n=20)
    m.frustum((0, 0, 1.3), (0, 0, 2.6), 1.15, 0.4, STEEL, n=20)
    m.sphere((0, 0, 2.7), 0.45, ALU, nlat=8, nlon=14)
    m.box((0.2, -0.7, -1.4), (0.6, 0.6, 0.5), DARK)
    m.frustum((0.2, -0.7, -1.7), (0.2, -0.7, -2.2), 0.3, 0.1, ALU, n=8)
    m.wing(0.9, 4.9, 2.3, segs=2)
    m.wing(-0.9, -4.9, 2.3, segs=2)
    m.dish((0, -1.7, -0.2), 1.1, (0, -0.4, 0.3), WHITE, depth=0.22, n=20)
    m.tube((0, -0.8, 0.1), (0, -1.7, -0.2), 0.03, ALU, n=4)
    return m


def _m71_bus(m, lander=True, panel=2.6):
    m.frustum((0, 0, -1.7), (0, 0, -0.9), 1.0, 1.7, STEEL, n=24)
    m.cyl((0, 0, -0.5), 1.55, 0.9, GOLD, n=24)
    m.cyl((0, 0, 0.4), 0.8, 1.0, WHITE, n=18)
    if lander:
        m.frustum((0, 0, 0.9), (0, 0, 1.9), 1.45, 0.25, STEEL, n=24)
        m.sphere((0, 0, 2.0), 0.3, ALU, nlat=6, nlon=10)
    m.wing(1.0, 1.0 + 2 * panel, 1.5, y=0.0, z=0.2, segs=2)
    m.wing(-1.0, -1.0 - 2 * panel, 1.5, y=0.0, z=0.2, segs=2)
    m.dish((0, -1.55, 0.0), 0.85, (0, -0.8, 0.2), WHITE, depth=0.25, n=20)
    m.tube((0, -0.8, -0.1), (0, -1.55, 0.0), 0.03, ALU, n=4)


def mars3():
    """Mars 2, 3 and 6 (1971-73): the M-71 orbiter bus (a 3.4 m tank ring, the instrument section, two 2.6 m panel pairs, a 2.5 m
    dish) with the 1.2 m lander inside its 2.9 m conical aeroshell on top (Mars 6 carried the M-73 lander and a flyby bus).
    """
    m = Craft()
    _m71_bus(m)
    return m


def phobos():
    """Phobos 1 and 2 (1988): the 6.2 t bus (a toroidal propulsion tank, the instrument cylinder, a small hopper lander on top, two
    panel pairs 6.7 m across, a dish) of the 3MV-derived design."""
    m = Craft()
    m.frustum((0, 0, -1.3), (0, 0, -0.7), 0.9, 1.35, STEEL, n=24)
    m.cyl((0, 0, -0.35), 1.35, 0.7, GOLD, n=24)
    m.cyl((0, 0, 0.9), 0.95, 1.9, WHITE, n=20)
    m.box((0, 0, 2.1), (0.8, 0.8, 0.5), GREY)
    m.sphere((0, 0, 2.5), 0.3, ALU, nlat=6, nlon=10)
    m.wing(1.0, 4.4, 1.3, z=0.9, segs=2)
    m.wing(-1.0, -4.4, 1.3, z=0.9, segs=2)
    m.dish((0, -1.4, 0.8), 0.7, (0, -0.8, 0.2), WHITE)
    m.tube((0, -0.9, 0.8), (0, -1.4, 0.8), 0.03, ALU, n=4)
    return m


def fobosgrunt():
    """Fobos-Grunt (2011): the stack of the propulsion module (a 3.4 m ring tank), the soil-return capsule cone and the Chinese
    Yinghuo-1 orbiter, 3.7 m high; two small panel wings and a dish."""
    m = Craft()
    m.cyl((0, 0, -0.9), 1.7, 0.9, STEEL, n=28)
    m.frustum((0, 0, -0.45), (0, 0, 0.4), 1.5, 0.95, GOLD, n=24)
    m.cyl((0, 0, 0.8), 0.95, 0.8, WHITE, n=20)
    m.frustum((0, 0, 1.2), (0, 0, 2.3), 0.9, 0.2, ALU, n=20)
    m.box((1.2, 0.0, 1.0), (0.5, 0.5, 0.4), DARK)
    m.wing(1.7, 4.2, 1.2, z=-0.6, segs=2)
    m.wing(-1.7, -4.2, 1.2, z=-0.6, segs=2)
    m.dish((0, -1.2, 0.3), 0.6, (0, -0.8, 0.2), WHITE)
    return m


def mars96():
    """Mars 96 (1996): the 6.1 t orbiter's drum (2.2 m across) with two penetrators and two small stations on its sides, four 4 m
    panels, a boom and a dish."""
    m = Craft()
    m.cyl((0, 0, 0), 1.1, 2.6, WHITE, n=24)
    m.cyl((0, 0, -1.5), 1.2, 0.4, STEEL, n=24)
    m.frustum((0, 0, -1.3), (0, 0, -2.2), 1.0, 0.45, GOLD, n=20)
    for s in (-1, 1):
        m.frustum((s * 1.2, 0, 0.5), (s * 1.2, 0, 1.4), 0.4, 0.12, ALU, n=10)
        m.cyl((s * 1.2, 0, 0.1), 0.4, 0.6, GREY, n=10)
    m.wing(1.2, 5.2, 1.2, y=-0.3, z=-0.4, segs=2)
    m.wing(-1.2, -5.2, 1.2, y=-0.3, z=-0.4, segs=2)
    m.wing(1.2, 5.2, 1.2, y=0.3, z=0.9, segs=2)
    m.wing(-1.2, -5.2, 1.2, y=0.3, z=0.9, segs=2)
    m.dish((0, -1.8, 0.8), 0.7, (0, -0.8, 0.2), WHITE)
    m.tube((0, -1.1, 0.8), (0, -1.8, 0.8), 0.03, ALU, n=4)
    return m


def salyut7():
    """Salyut 7 (1982): 20 m long, 4.15 m at its widest: the small docking compartment, the 2.9 m working compartment, the big
    4.15 m one, the unpressurised service module aft, three pairs of 2.1 by 7.6 m panels.
    """
    m = Craft()
    m.frustum((0, 0, -9.3), (0, 0, -8.0), 0.65, 1.1, ALU, n=18)
    m.cyl((0, 0, -6.5), 1.5, 2.9, WHITE, n=20)
    m.frustum((0, 0, -5.05), (0, 0, -4.3), 1.5, 2.07, ALU, n=20)
    m.cyl((0, 0, -1.8), 2.07, 5.0, WHITE, n=20)
    m.frustum((0, 0, 0.7), (0, 0, 1.4), 2.07, 1.5, ALU, n=20)
    m.cyl((0, 0, 3.7), 1.5, 5.4, STEEL, n=20)
    m.frustum((0, 0, 6.4), (0, 0, 7.4), 1.5, 0.6, GOLD, n=20)
    m.cyl((0, 0, 7.9), 0.65, 1.0, ALU, n=12)
    m.wing(1.6, 8.8, 2.1, z=-5.0, segs=2)
    m.wing(-1.6, -8.8, 2.1, z=-5.0, segs=2)
    m.wing(2.0, 9.2, 2.1, z=-0.5, segs=2)
    m.wing(-2.0, -9.2, 2.1, z=-0.5, segs=2)
    m.wing(1.6, 8.8, 2.1, z=4.5, segs=2)
    m.wing(-1.6, -8.8, 2.1, z=4.5, segs=2)
    return m


# ── Earth orbit ──
def vanguard1():
    """Vanguard 1 (1958): the 16.3 cm sphere, 1.47 kg, six short rod antennas (the grapefruit)."""
    m = Craft()
    m.sphere((0, 0, 0), 0.0815, STEEL, nlat=10, nlon=16)
    for k in range(6):
        a = math.radians(60 * k)
        m.tube((0.07 * math.cos(a), 0.07 * math.sin(a), 0.0), (0.3 * math.cos(a), 0.3 * math.sin(a), 0.0), 0.004, ALU, n=4)
    return m


def gps():
    """A GPS III satellite (2018): the 1.8 by 2.5 by 3.4 m bus (about 2,200 kg) with the L-band array facing Earth and two arrays of
    two panels (about 7 m across); the cross-link and the laser retroreflector on the face."""
    m = Craft()
    m.block((0, 0, 0), (1.8, 2.5, 3.4), GOLD)
    m.box((0.0, -1.3, 0.0), (1.3, 0.12, 1.3), WHITE)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        m.box((0.45 * math.cos(a), -1.38, 0.45 * math.sin(a)), (0.4, 0.06, 0.4), ALU)
    m.wing(1.05, 4.6, 2.2, segs=2)
    m.wing(-1.05, -4.6, 2.2, segs=2)
    m.hdish((0.0, 1.5, 1.0), 0.4)
    return m


def gaia():
    """Gaia (2013): the 10 m sunshield, a dodecagon of twelve cell panels round the 2.3 m payload drum, the twin telescopes' baffles on
    top and the phased-array antenna below the shield."""
    m = Craft()
    r = 5.0
    for k in range(12):
        a = math.radians(30 * k + 15)
        m.flatpanel((r * 0.6 * math.cos(a), r * 0.6 * math.sin(a), -0.6), r * 0.82, r * 0.54, rotz=a + math.pi / 2, cell=0.35, thick=0.05)
    m.cyl((0, 0, -0.62), 1.3, 0.1, ALU, n=12)
    m.cyl((0, 0, 0.5), 1.45, 2.3, WHITE, n=24)
    m.frustum((0, 0, 1.6), (0, 0, 2.3), 1.45, 1.1, GOLD, n=24)
    for dx in (-0.45, 0.45):
        m.frustum((dx, 0, 2.3), (dx, 0, 3.0), 0.45, 0.4, DARK, n=12)
    m.cyl((0, 0, -0.95), 0.9, 0.3, GREY, n=16)
    for k in range(6):
        a = math.radians(60 * k)
        m.cyl((0.5 * math.cos(a), 0.5 * math.sin(a), -1.15), 0.12, 0.1, GRID, n=8)
    m.tube((1.4, 0.0, 0.5), (3.5, 0.0, 0.5), 0.02, DARK, n=4)
    return m


# ── ESA ──
def _esa_box(
    m, size=(1.5, 1.8, 1.4), dish=0.8, wing=(3.4, 2), chord=1.7, color=GOLD, z=0.0
):
    m.block((0, 0, z), size, color)
    m.hdish((0, -size[1] / 2 - 0.25 * dish, z + 0.1), dish)
    if wing:
        m.wing(size[0] / 2 + 0.2, size[0] / 2 + 0.2 + wing[0], chord, z=z, segs=wing[1])
        m.wing(
            -size[0] / 2 - 0.2, -size[0] / 2 - 0.2 - wing[0], chord, z=z, segs=wing[1]
        )


def mex():
    """Mars Express (2003): the 1.5 by 1.8 by 1.4 m box in gold foil, the 1.6 m dish, two arrays of two 2 m panels (12 m across)."""
    m = Craft()
    _esa_box(m, (1.5, 1.8, 1.4), 0.8, (3.9, 2), 1.7)
    m.tube((0.75, 0.5, 0.7), (4.0, 0.5, 0.7), 0.012, DARK, n=4)  # a MARSIS boom
    return m


def venusexpress():
    """Venus Express (2005): the same box as Mars Express, a 1.3 m dish, two 2.5 m arrays (8 m across), and a magnetometer boom."""
    m = Craft()
    _esa_box(m, (1.65, 1.7, 1.4), 0.65, (2.4, 1), 2.0)
    m.tube((0, 0.85, 0.5), (0, 2.2, 1.4), 0.02, DARK, n=4)
    return m


def tgo():
    """ExoMars Trace Gas Orbiter (2016): the 3.2 by 2.0 by 2.0 m bus, the 2.2 m dish, two 2 by 3.6 m arrays (17.5 m across)."""
    m = Craft()
    m.block((0, 0, 0), (2.0, 3.2, 2.0), GOLD)
    m.box((0, -1.62, 0.3), (1.8, 0.05, 1.0), WHITE)
    m.hdish((0, -2.3, 0.2), 1.1)
    m.wing(1.2, 8.2, 2.0, segs=2)
    m.wing(-1.2, -8.2, 2.0, segs=2)
    m.box((0.6, -1.7, -0.6), (0.5, 0.3, 0.4), DARK)
    return m


def schiaparelli():
    """Schiaparelli (2016): the 2.4 m, 70-degree heat shield cone, the conical backshell with its parachute lid and the 0.6 m
    top cylinder; 600 kg."""
    m = Craft()
    m.frustum((0, 0, -0.1), (0, 0, 0.55), 0.08, 1.2, DARK, n=32, caps=True)  # the forebody, nose down
    m.frustum((0, 0, 0.55), (0, 0, 1.35), 0.5, 0.35, WHITE, n=24)
    m.frustum((0, 0, 0.45), (0, 0, 0.95), 1.15, 0.5, ALU, n=32, caps=False)
    m.cyl((0, 0, 1.45), 0.34, 0.2, GOLD, n=16)
    m.cyl((0, 0, 1.0), 0.2, 0.12, DARK, n=10)
    m.frustum((0, 0, 0.5), (0, 0, 0.62), 1.2, 1.2, GRID, n=32, caps=False)
    for k in range(8):
        a = math.radians(45 * k)
        m.cyl((0.6 * math.cos(a), 0.6 * math.sin(a), 0.78), 0.05, 0.08, GREY, n=8)
    return m


def beagle2():
    """Beagle 2 (2003): a 0.65 m clamshell lander, 33 kg, its four solar panels open like petals and the arm with the PAW in front."""
    m = Craft()
    m.cyl((0, 0, 0.12), 0.33, 0.24, WHITE, n=16)
    m.cyl((0, 0, 0.28), 0.3, 0.06, GOLD, n=16)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        ca, sa = math.cos(a), math.sin(a)
        m.flatpanel((0.62 * ca, 0.62 * sa, 0.16), 0.55, 0.32, rotz=a)
        m.tube((0.3 * ca, 0.3 * sa, 0.15), (0.9 * ca, 0.9 * sa, 0.17), 0.012, ALU, n=4)
    m.tube((0.1, -0.25, 0.3), (0.4, -0.7, 0.5), 0.02, ALU, n=6)
    m.tube((0.4, -0.7, 0.5), (0.55, -1.0, 0.25), 0.02, ALU, n=6)
    m.cyl((0.58, -1.05, 0.22), 0.1, 0.12, DARK, n=8)
    m.sphere((-0.1, 0.0, 0.31), 0.08, ALU, nlat=4, nlon=8)
    return m


def solarorbiter():
    """Solar Orbiter (2020): the 3.1 by 2.4 m titanium heat shield, 1.5 m in front of the 2.5 by 3.0 by 1.8 m body, two 2.1 by 2.2 m
    arrays (18 m across), the 1.1 m dish and the 4.4 m magnetometer boom."""
    m = Craft()
    m.block((0, 0, 0), (3.0, 2.5, 1.8), GOLD)
    m.box(
        (0, 1.45, 0.05), (3.1, 0.12, 2.4), DARK
    )  # the shield stands behind the bus, toward the Sun
    m.box((0, 1.5, 0.05), (2.9, 0.02, 2.2), STEEL)
    for s in (-1, 1):
        m.tube((s * 1.1, 1.2, 0.0), (s * 1.1, 1.4, 0.0), 0.04, ALU, n=4)
        m.wing(s * 1.7, s * 8.9, 2.2, y=-0.3, z=0.0, segs=3)
    m.hdish((0.5, -1.45, 0.4), 0.55)
    m.tube((-1.4, -1.0, -0.5), (-1.4, -1.0, -5.0), 0.025, DARK, n=4)
    return m


def juice():
    """JUICE (2023): the 3.3 m bus under its 2.5 m dish, two arrays of three 4.4 m panels (27 m across), the 16 m RIME antenna and the
    10.6 m magnetometer boom."""
    m = Craft()
    m.block((0, 0, 0), (2.4, 2.4, 3.6), GOLD)
    m.cyl((0, 0, -2.1), 0.6, 0.7, STEEL, n=12)
    m.hdish((0, -1.8, 0.9), 1.25)
    for s in (-1, 1):
        m.wing(s * 1.4, s * 14.6, 2.4, z=-0.2, segs=3)
    m.tube((-8.0, 1.5, 1.0), (8.0, 1.5, 1.0), 0.02, DARK, n=4)
    m.tube((0.9, 1.0, -1.0), (0.9, 1.0, -10.6), 0.03, DARK, n=4)
    return m


def smart1():
    """SMART-1 (2003): a 1 m cube (367 kg), two 14 m^2 arrays 14 m across, the ion engine below and a small S-band dish."""
    m = Craft()
    m.block((0, 0, 0), (1.0, 1.0, 1.1), GOLD)
    m.cyl((0, 0, -0.75), 0.18, 0.4, GREY, n=10)
    m.wing(0.6, 4.3, 1.5, segs=3)
    m.wing(-0.6, -4.3, 1.5, segs=3)
    m.hdish((0.2, -0.6, 0.35), 0.28)
    return m


# ── Asia and the Gulf ──
def _asian_box(m, size, dish, wings, chord, color=GOLD):
    m.block((0, 0, 0), size, color)
    m.hdish((size[0] * 0.2, -size[1] / 2 - 0.3 * dish, size[2] * 0.2), dish)
    for s, (ln, segs) in zip((1, -1), wings):
        if ln:
            m.wing(
                s * (size[0] / 2 + 0.2), s * (size[0] / 2 + 0.2 + ln), chord, segs=segs
            )


def change1():
    """Chang'e 1 (2007): the 2.0 by 1.7 by 2.2 m cube, 18 m^2 of panels on two wings (18 m across), the 0.9 m dish and the engine."""
    m = Craft()
    _asian_box(m, (2.0, 1.7, 2.2), 0.9, ((7.4, 2), (7.4, 2)), 1.7)
    m.cyl((0, 0.2, -1.4), 0.3, 0.5, GREY, n=10)
    return m


def kaguya():
    """Kaguya (SELENE, 2007): the 2.1 by 2.1 by 4.8 m main orbiter, its single 2.2 by 4.2 m array, the 1.3 m dish on top and the four
    15 m radar-sounder antennas."""
    m = Craft()
    m.block((0, 0, 0), (2.1, 2.1, 4.8), WHITE)
    m.box((0, -1.06, 1.4), (1.9, 0.04, 1.6), GOLD)
    m.wing(1.3, 5.2, 2.2, z=0.0, segs=2)
    m.hdish((0.0, -1.5, 2.9), 0.65)
    for ax in (1, -1):
        (
            m.tube((ax * 1.0, 0, 2.2), (ax * 7.0, 0, 2.2), 0.012, DARK, n=4)
            if False
            else None
        )
    m.tube((0, 0.2, 2.5), (6.0, 0.2, 2.5), 0.012, DARK, n=4)
    m.tube((0, 0.2, 2.5), (-6.0, 0.2, 2.5), 0.012, DARK, n=4)
    m.cyl((-1.7, 0, -2.0), 0.55, 1.0, WHITE, n=10)  # the relay sub-satellite, folded
    return m


def chandrayaan1():
    """Chandrayaan-1 (2008): the 1.5 m cube (1,380 kg), one 2.4 by 1.8 m array, the 0.7 m dish, and the Moon Impact Probe."""
    m = Craft()
    _asian_box(m, (1.5, 1.5, 1.5), 0.7, ((2.6, 1), (0, 1)), 1.8)
    m.box((-0.5, -0.82, 0.1), (0.45, 0.18, 0.5), BLUE)
    m.tube((0.0, 0.9, 0.5), (0.0, 2.2, 0.5), 0.02, DARK, n=4)
    return m


def chandrayaan2o():
    """The Chandrayaan-2 orbiter (2019): a 3.2 by 1.8 m bus (2,379 kg with the lander), two arrays 2.2 m across, a 0.75 m dish."""
    m = Craft()
    _asian_box(m, (3.2, 1.8, 2.0), 0.75, ((2.3, 1), (2.3, 1)), 2.0, color=WHITE)
    m.box((0, -0.93, 0.0), (1.4, 0.04, 1.4), GOLD)
    return m


def danuri():
    """Danuri (KPLO, 2022): the 678 kg bus about 2.3 by 1.8 m, one 4 by 2 m array on a mast, the 0.7 m dish and the magnetometer boom."""
    m = Craft()
    m.block((0, 0, 0), (1.8, 1.8, 2.3), GOLD)
    m.box((0, -0.95, 0.0), (1.5, 0.04, 1.6), STEEL)
    m.hdish((0.0, -1.25, 0.9), 0.55)
    m.wing(1.3, 5.3, 2.3, z=0.0, segs=2)
    m.tube((-0.9, 0.0, 0.5), (-0.9, 0.0, 3.5), 0.02, DARK, n=4)
    return m


def hayabusa2():
    """Hayabusa2 (2014): the 1.0 by 1.6 by 1.25 m body (610 kg), two 2.3 by 1.4 m arrays (6 m across), the flat 0.9 by 0.6 m antennas, the
    sampler horn below and the ion engines."""
    m = Craft()
    m.block((0, 0, 0), (1.0, 1.25, 1.6), GOLD)
    m.box((0.0, -0.66, 0.5), (0.9, 0.08, 0.6), WHITE)
    m.box((0.0, -0.66, -0.25), (0.5, 0.08, 0.5), GREY)
    m.wing(0.7, 3.0, 1.6, segs=2)
    m.wing(-0.7, -3.0, 1.6, segs=2)
    m.frustum((0, 0, -0.8), (0, 0, -1.7), 0.18, 0.06, DARK, n=8)
    return m


def hope():
    """Hope (Emirates Mars Mission, 2020): 1.8 by 1.4 m bus (1,350 kg), two 3.4 m arrays of 2.2 m, the 1.0 m dish and the camera side."""
    m = Craft()
    m.block((0, 0, 0), (1.8, 1.4, 2.0), WHITE)
    m.box((0.0, -0.74, 0.0), (1.5, 0.04, 1.5), GOLD)
    m.hdish((0.2, -1.1, 0.5), 0.55)
    m.wing(1.1, 4.4, 2.2, segs=2)
    m.wing(-1.1, -4.4, 2.2, segs=2)
    m.tube((0.0, 0.7, 1.0), (0.0, 0.7, 2.4), 0.02, DARK, n=4)
    return m


def tianwen1():
    """Tianwen-1 (2020): the orbiter's box and its 2 by 3 m wing pair, the 0.8 m dish, and the lander in its 3.4 m aeroshell below."""
    m = Craft()
    m.block((0, 0, 1.4), (2.4, 2.0, 1.6), GOLD)
    m.hdish((0.3, -1.3, 1.6), 0.8)
    m.wing(1.4, 5.6, 1.9, z=1.4, segs=2)
    m.wing(-1.4, -5.6, 1.9, z=1.4, segs=2)
    m.frustum((0, 0, 0.4), (0, 0, -0.5), 1.7, 1.2, GREY, n=32)
    m.frustum((0, 0, 0.4), (0, 0, 0.62), 1.7, 1.7, WHITE, n=32)
    m.cyl((0, 0, 0.95), 0.5, 0.6, DARK, n=12)
    return m


# ── Commercial lunar landers and the older Soviet landers ──
def hakuto():
    """Hakuto-R Mission 1 (ispace, 2022): the 2.3 m, 340 kg lander, a central tank and the box deck, four splayed legs and a panel on top."""
    m = Craft()
    m.cyl((0, 0, 0.7), 0.7, 0.8, WHITE, n=8)
    m.sphere((0, 0, 1.15), 0.5, GOLD, nlat=6, nlon=12)
    m.flatpanel((0, 0, 1.5), 1.5, 1.2)
    m.legs(4, 0.6, 0.5, 1.6, -0.1, rad=0.06, pad=0.2)
    m.tube((0.5, -0.5, 1.5), (0.8, -0.8, 2.0), 0.02, ALU, n=4)
    m.cyl((0, 0, 0.1), 0.25, 0.3, GREY, n=10)
    return m


def beresheet():
    """Beresheet (SpaceIL, 2019): 1.5 m across and 1.5 m high, 585 kg, a round tank body with cells on its sides, four legs, a small dish."""
    m = Craft()
    m.cyl((0, 0, 0.6), 0.75, 0.9, GOLD, n=16)
    m.cyl((0, 0, 0.62), 0.77, 0.45, CELLS, n=16)
    m.sphere((0, 0, 1.05), 0.55, WHITE, nlat=6, nlon=12, zmin=0.0)
    m.legs(4, 0.55, 0.3, 1.25, -0.5, rad=0.05, pad=0.2)
    m.tube((0.3, -0.3, 1.4), (0.4, -0.5, 1.7), 0.015, ALU, n=4)
    m.dish((0.4, -0.5, 1.75), 0.22, (0.3, -0.7, 0.6), WHITE)
    m.box((-0.6, -0.4, 0.55), (0.25, 0.25, 0.3), DARK)
    return m


def peregrine():
    """Peregrine (Astrobotic, 2024): the 1.9 m, 1,283 kg lander, a broad deck over the tank cluster, four legs 2.5 m across, a top panel."""
    m = Craft()
    m.cyl((0, 0, 0.55), 0.95, 0.7, GOLD, n=12)
    m.box((0, 0, 1.0), (1.9, 1.9, 0.12), WHITE)
    m.flatpanel((0, 0, 1.12), 1.7, 1.7)
    for x, y in ((0.55, 0.5), (-0.55, 0.5), (0.55, -0.5), (-0.55, -0.5)):
        m.sphere((x, y, 1.35), 0.3, STEEL, nlat=5, nlon=8)
    m.legs(4, 0.8, 0.4, 1.4, -0.2, rad=0.06, pad=0.22)
    return m


def luna25():
    """Luna 25 (2023): the 1,750 kg lander's drum and its four tall legs, the fixed panels on top, the arm and the camera mast."""
    m = Craft()
    m.cyl((0, 0, 0.95), 0.9, 1.3, WHITE, n=16)
    m.cyl((0, 0, 0.5), 0.92, 0.3, STEEL, n=16)
    m.legs(4, 0.7, 0.9, 1.6, -0.1, rad=0.06, pad=0.22)
    m.flatpanel((0.0, 0.0, 1.65), 1.2, 1.5)
    m.tube((0.2, -0.5, 1.4), (0.7, -1.4, 1.1), 0.025, ALU, n=6)
    m.tube((0.7, -1.4, 1.1), (0.9, -1.7, 0.5), 0.025, ALU, n=6)
    m.tube((-0.5, -0.3, 1.6), (-0.5, -0.3, 2.3), 0.025, ALU, n=6)
    m.box((-0.5, -0.3, 2.35), (0.25, 0.1, 0.1), DARK)
    return m


def tiangong():
    """Tiangong-1 and -2 (2011, 2016): 10.4 m long, 3.35 m across: the 3.35 m experiment module, the narrower resource module aft, the
    docking cone and two pairs of 3 by 10 m wings."""
    m = Craft()
    m.cyl((0, 0, 1.6), 1.67, 3.7, WHITE, n=24)
    m.frustum((0, 0, 3.45), (0, 0, 4.4), 1.67, 0.7, ALU, n=24)
    m.cyl((0, 0, 4.8), 0.7, 0.8, DARK, n=16)
    m.cyl((0, 0, -2.3), 1.2, 4.3, STEEL, n=24)
    m.frustum((0, 0, -0.45), (0, 0, -0.1), 1.2, 1.67, ALU, n=24)
    for z in (-3.2, 0.5):
        m.wing(1.3, 6.3, 2.4, z=z, segs=2) if z < 0 else None
    m.wing(1.4, 6.6, 2.5, z=-3.2, segs=2)
    m.wing(-1.4, -6.6, 2.5, z=-3.2, segs=2)
    m.wing(1.8, 6.0, 2.0, z=1.0, segs=2)
    m.wing(-1.8, -6.0, 2.0, z=1.0, segs=2)
    return m


def uars():
    """UARS (1991): the Upper Atmosphere Research Satellite, 10.7 m by 4.6 m, 5,900 kg: a box bus, one 15 by 2.5 m array and a dish boom."""
    m = Craft()
    m.block((0, 0, 0), (4.6, 2.0, 2.4), STEEL)
    m.box((0, -1.02, 0.3), (4.0, 0.04, 1.4), WHITE)
    m.wing(2.6, 10.0, 2.5, y=0.2, segs=3)
    m.tube((-2.0, 1.0, 1.2), (-3.0, 1.2, 3.8), 0.04, ALU, n=4)
    m.dish((-3.0, 1.2, 3.8), 0.7, (0, -1, 1), WHITE)
    m.cyl((0, 0, -1.6), 0.8, 0.9, GREY, n=12)
    return m


# ── Venus and Mars orbiters of the 1980s and 90s ──
def pvo():
    """Pioneer Venus Orbiter (1978): a 2.5 m drum 1.2 m high wrapped in cells, the 1.1 m despun dish on its axis, the 4.7 m boom."""
    m = Craft()
    m.cyl((0, 0, 0), 1.25, 1.2, CELLS, n=24)
    m.cyl((0, 0, 0.62), 1.28, 0.05, ALU, n=24)
    m.cyl((0, 0, -0.62), 1.28, 0.05, ALU, n=24)
    m.cyl((0, 0, 0.9), 0.3, 0.5, GREY, n=10)
    m.dish((0, 0, 1.5), 0.55, (0, 0, 1), WHITE, depth=0.25)
    m.tube((0, 0, -0.62), (0, 0, -1.6), 0.05, ALU, n=6)
    m.tube((0, 0, 0.0), (4.7, 0, 0.0), 0.025, DARK, n=4)
    for k in range(24):
        a = math.radians(15 * k + 7.5)
        m.tube((1.255 * math.cos(a), 1.255 * math.sin(a), -0.58), (1.255 * math.cos(a), 1.255 * math.sin(a), 0.58), 0.006, GRID, n=3)
    m.instrument((1.0, 0.7, 0.4), 0.1, 0.2, axis='z')
    return m


def akatsuki():
    """Akatsuki (Venus Climate Orbiter, 2010): the 1.04 by 1.45 by 1.4 m box, two 1.4 m panels, flat 0.8 m antennas and the thruster."""
    m = Craft()
    m.block((0, 0, 0), (1.45, 1.04, 1.4), GOLD)
    m.box((0.0, -0.55, 0.45), (0.7, 0.06, 0.7), WHITE)
    m.box((0.0, -0.55, -0.35), (0.5, 0.06, 0.5), WHITE)
    m.wing(0.95, 3.1, 1.4, segs=2)
    m.wing(-0.95, -3.1, 1.4, segs=2)
    m.cyl((0, 0, -0.85), 0.15, 0.3, GREY, n=8)
    return m


def marsobserver():
    """Mars Observer (1992): the 2.2 m box bus (2,573 kg), the 1.5 m dish, the one 7 m, 3.4 m-wide array and the 6 m magnetometer boom."""
    m = Craft()
    m.block((0, 0, 0), (1.6, 1.6, 2.2), GOLD)
    m.box((0, -0.82, 0.3), (1.3, 0.04, 1.3), WHITE)
    m.hdish((0.0, -1.2, 0.6), 0.75)
    m.wing(1.0, 6.6, 3.0, segs=4)
    m.tube((0.0, 0.8, -0.8), (0.0, 0.8, -6.0), 0.025, DARK, n=4)
    m.tube((-0.8, 0.0, 0.8), (-4.2, 0.0, 1.0), 0.025, DARK, n=4)
    return m


def mco():
    """Mars Climate Orbiter (1998): the 2.1 by 1.6 by 2.0 m bus (638 kg), one 5.5 by 1.9 m array on its side and the 1.3 m dish."""
    m = Craft()
    m.block((0, 0, 0), (1.6, 2.1, 2.0), GOLD)
    m.box((0, -1.06, 0.4), (1.3, 0.04, 1.0), WHITE)
    m.hdish((0.3, -1.45, 0.5), 0.65)
    m.wing(1.0, 6.4, 1.9, segs=3)
    m.tube((-0.8, 0.0, 1.1), (-0.8, 0.0, 2.4), 0.02, DARK, n=4)
    return m


def mpl():
    """Mars Polar Lander (1999): the 1.06 m deck on three 1.5 m legs, two rectangular panels folded out, the dish and UHF mast, the arm."""
    m = Craft()
    m.cyl((0, 0, 0.9), 0.75, 0.12, GOLD, n=6)
    m.box((0.0, 0.1, 1.1), (0.8, 0.6, 0.3), WHITE)
    for k in range(3):
        a = math.radians(90 + 120 * k)
        ca, sa = math.cos(a), math.sin(a)
        m.tube(
            (0.55 * ca, 0.55 * sa, 0.95), (1.3 * ca, 1.3 * sa, 0.05), 0.045, ALU, n=6
        )
        m.cyl((1.3 * ca, 1.3 * sa, 0.03), 0.2, 0.06, ALU, n=8)
    for s in (-1, 1):
        m.flatpanel((s * 1.2, 0.0, 1.0), 1.0, 0.8)
        m.tube((s * 0.7, 0, 1.0), (s * 0.9, 0, 1.0), 0.02, ALU, n=4)
    m.tube((0.0, 0.3, 1.2), (0.0, 0.3, 1.9), 0.025, ALU, n=6)
    m.dish((0.0, 0.3, 1.95), 0.18, (0, -0.3, 1), WHITE)
    m.tube((0.4, -0.3, 1.0), (0.9, -0.9, 0.7), 0.025, ALU, n=6)
    return m


def ds2():
    """Deep Space 2 (1999): one of the two Mars microprobes, a 0.35 m, 2.4 kg aeroshell with a 10 cm penetrator inside."""
    m = Craft()
    m.sphere((0, 0, 0.0), 0.175, GREY, nlat=8, nlon=14, zmin=-0.05, scale=(1, 1, 0.8))
    m.frustum((0, 0, -0.02), (0, 0, 0.2), 0.175, 0.04, DARK, n=20)
    m.frustum((0, 0, -0.18), (0, 0, -0.02), 0.04, 0.17, ALU, n=20, caps=False)
    m.tube((0, 0, 0.2), (0, 0, 0.33), 0.012, ALU, n=6)
    m.cyl((0, 0, 0.0), 0.2, 0.03, GOLD, n=20)
    return m


# ── The instruments, thrusters, tanks and booms a photograph shows, added to each body above ──
def _thrusters(m, pts, r=0.05, ln=0.14):
    for x, y, z in pts:
        m.frustum((x, y, z), (x, y, z - ln), r * 0.5, r, GREY, n=8)


def _x_mex(m):
    m.instrument((-0.35, -0.92, -0.3), 0.12, 0.28)
    m.instrument((0.3, -0.92, -0.35), 0.09, 0.2)
    m.box((0.1, -0.92, -0.5), (0.3, 0.1, 0.2), DARK)
    m.frustum((0, 0, -0.7), (0, 0, -1.05), 0.1, 0.24, GREY, n=14)
    _thrusters(m, [(-0.6, 0.7, -0.6), (0.6, 0.7, -0.6)])
    m.tube((-0.75, 0.5, 0.7), (-4.2, 0.5, 0.7), 0.014, DARK, n=4)
    m.cyl((0.0, 0.1, 0.78), 0.33, 0.12, WHITE, n=16)  # the Beagle 2 mount


def _x_vex(m):
    m.instrument((-0.4, -0.88, -0.35), 0.1, 0.25)
    m.instrument((0.35, -0.88, -0.3), 0.08, 0.2)
    m.frustum((0, 0, -0.7), (0, 0, -1.0), 0.09, 0.22, GREY, n=14)
    _thrusters(m, [(-0.6, 0.6, -0.6), (0.6, 0.6, -0.6)])
    m.cyl((0.9, 0.0, 0.8), 0.22, 0.3, WHITE, n=12, axis="x")


def _x_tgo(m):
    m.instrument((-0.55, -1.65, -0.3), 0.16, 0.3)
    m.box((0.5, -1.64, -0.45), (0.5, 0.08, 0.3), DARK)
    m.box((-0.3, -1.64, 0.55), (0.6, 0.08, 0.25), GREY)
    m.frustum((0, 0, -1.0), (0, 0, -1.5), 0.12, 0.3, GREY, n=14)
    _thrusters(m, [(-0.8, 1.4, -0.9), (0.8, 1.4, -0.9)])
    m.box((0.0, 0.0, 1.05), (1.7, 2.8, 0.08), WHITE)


def _x_haya(m):
    for dx in (-0.2, 0.2):
        for dy in (-0.2, 0.2):
            m.cyl((dx, dy, -0.85), 0.06, 0.25, GREY, n=8)
    m.frustum((0.35, 0.1, -0.8), (0.35, 0.1, -1.3), 0.12, 0.12, WHITE, n=10)  # the impactor
    m.box((-0.35, -0.2, -0.78), (0.3, 0.3, 0.25), GREY)  # the lander
    m.instrument((0.2, -0.66, -0.3), 0.07, 0.15)
    m.instrument((-0.2, -0.66, -0.1), 0.05, 0.12)
    m.cyl((-0.6, 0.0, 0.55), 0.05, 0.4, DARK, n=6, axis="x")


def _x_hope(m):
    m.instrument((-0.45, -0.78, -0.5), 0.12, 0.3)
    m.instrument((0.4, -0.78, -0.4), 0.08, 0.2)
    m.frustum((0, 0, -1.0), (0, 0, -1.3), 0.1, 0.22, GREY, n=12)
    _thrusters(m, [(-0.7, 0.6, -0.9), (0.7, 0.6, -0.9)])


def _x_akatsuki(m):
    m.instrument((-0.3, -0.54, -0.2), 0.08, 0.2)
    m.instrument((0.3, -0.54, -0.35), 0.06, 0.15)
    m.frustum((0, 0, -0.7), (0, 0, -0.95), 0.1, 0.24, GREY, n=12)
    m.cyl((0.0, 0.0, 0.85), 0.12, 0.3, WHITE, n=10)
    m.tube((0.2, 0.3, 0.7), (0.2, 0.3, 2.0), 0.015, DARK, n=4)


def _x_solo(m):
    m.instrument((-0.6, -1.3, -0.3), 0.15, 0.3)
    m.instrument((0.7, -1.3, -0.4), 0.12, 0.25)
    m.box((-0.2, -1.3, 0.5), (0.8, 0.08, 0.3), DARK)
    m.frustum((0, 0, -0.9), (0, 0, -1.3), 0.12, 0.26, GREY, n=14)
    m.cyl((0.0, 0.8, 1.0), 0.1, 1.0, DARK, n=8)


def _x_juice(m):
    m.frustum((0, 0, -2.4), (0, 0, -3.1), 0.16, 0.38, GREY, n=14)
    m.instrument((-0.7, -1.25, -0.8), 0.15, 0.35)
    m.instrument((0.7, -1.25, -1.0), 0.11, 0.3)
    m.tank((1.4, 0.0, -1.2), 0.45)
    m.tank((-1.4, 0.0, -1.2), 0.45)
    m.tube((1.0, 0.9, 1.0), (4.8, 1.6, 1.0), 0.015, DARK, n=4)


def _x_smart(m):
    m.cyl((0, 0, -0.95), 0.13, 0.2, STEEL, n=10)
    m.instrument((-0.2, -0.52, 0.1), 0.07, 0.15)
    m.instrument((0.2, -0.52, -0.2), 0.05, 0.12)


def _x_asian(m):
    m.instrument((-0.45, -0.9, -0.5), 0.1, 0.22)
    m.instrument((0.4, -0.9, -0.2), 0.07, 0.18)
    _thrusters(m, [(-0.5, 0.6, -1.0), (0.5, 0.6, -1.0)])


def _x_kaguya(m):
    m.instrument((-0.4, -1.1, -1.2), 0.2, 0.4)
    m.instrument((0.4, -1.1, 0.4), 0.12, 0.3)
    m.frustum((0, 0, -2.4), (0, 0, -2.9), 0.15, 0.35, GREY, n=14)
    m.cyl((1.7, 0.2, -2.0), 0.55, 1.0, WHITE, n=10)


def _x_tianwen(m):
    m.instrument((-0.5, -1.05, 1.0), 0.14, 0.3)
    m.instrument((0.5, -1.05, 1.9), 0.08, 0.2)
    m.cyl((0, 0, 0.05), 0.3, 0.2, DARK, n=12)


def _x_mo(m):
    m.instrument((-0.4, -0.85, -0.6), 0.15, 0.3)
    m.instrument((0.4, -0.85, -0.9), 0.1, 0.25)
    m.frustum((0, 0, -1.1), (0, 0, -1.5), 0.1, 0.25, GREY, n=12)


def _x_gps(m):
    m.cyl((0.0, 1.35, 0.0), 0.5, 0.1, ALU, n=12, axis="y")
    for z in (-1.5, 1.5):
        m.box((0.0, 0.2, z), (1.7, 2.3, 0.05), WHITE)
    m.tube((0.7, 1.3, 0.0), (1.4, 1.7, 0.0), 0.012, DARK, n=4)


def _x_uars(m):
    m.instrument((-1.4, -1.05, 0.2), 0.3, 0.4)
    m.instrument((0.3, -1.05, -0.3), 0.2, 0.3)
    m.box((1.4, -1.05, 0.2), (0.7, 0.1, 0.5), DARK)
    m.cyl((-2.4, 0.0, 0.0), 0.1, 1.2, STEEL, n=8, axis="x")


def _x_ranger(m):
    m.instrument((0.0, -0.35, 3.15), 0.09, 0.2)
    m.cyl((0.0, 0.0, 0.5), 0.35, 0.18, ALU, n=6)
    m.tube((0.0, 0.0, 0.15), (0.0, 0.0, -0.5), 0.07, GOLD, n=8)


def _x_lunar_orbiter(m):
    m.instrument((0.0, -0.55, 1.2), 0.13, 0.3)
    m.frustum((0, 0, 1.8), (0, 0, 2.7), 0.02, 0.01, ALU, n=4)
    m.cyl((0.0, 0.0, 0.2), 0.84, 0.05, GRID, n=16)


def _x_vega(m):
    m.cyl((0.0, 0.0, 2.45), 0.55, 0.12, ALU, n=18)
    m.box((0.5, 0.5, 0.5), (0.3, 0.3, 0.4), GREY)
    m.cyl((0.0, 0.0, 0.9), 0.82, 0.08, ALU, n=18)


def _x_mars(m):
    m.cyl((0, 0, 1.0), 0.4, 0.2, DARK, n=12)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        m.tank((1.3 * math.cos(a), 1.3 * math.sin(a), -0.5), 0.3)
    m.tube((0.9, 0.3, 0.8), (0.9, 0.3, 2.2), 0.02, ALU, n=4)


def _x_lander(m):
    m.instrument((0.5, -0.6, 1.0), 0.07, 0.15)
    m.tube((-0.4, 0.4, 1.0), (-0.4, 0.4, 1.8), 0.02, ALU, n=4)
    m.frustum((0, 0, 0.3), (0, 0, -0.1), 0.15, 0.32, GREY, n=12)


def _x_station(m):
    for z in (-2.5, 0.5, 3.0):
        m.tube((0, 1.7, z), (0, 2.2, z), 0.04, ALU, n=4)
    m.dish((0, 2.3, -2.5), 0.5, (0, 1, 0), WHITE)


EXTRAS = {
    "mex": _x_mex, "venusexpress": _x_vex, "tgo": _x_tgo, "hayabusa2": _x_haya, "hope": _x_hope, "akatsuki": _x_akatsuki,
    "solarorbiter": _x_solo, "juice": _x_juice, "smart1": _x_smart, "change1": _x_asian, "chandrayaan1": _x_asian,
    "chandrayaan2o": _x_asian, "danuri": _x_asian, "kaguya": _x_kaguya, "tianwen1": _x_tianwen, "marsobserver": _x_mo, "mco": _x_mo,
    "gps": _x_gps, "uars": _x_uars, "ranger": _x_ranger, "lunar_orbiter": _x_lunar_orbiter, "vega": _x_vega, "mars3": _x_mars,
    "phobos": _x_mars, "mpl": _x_lander, "hakuto": _x_lander, "peregrine": _x_lander, "luna25": _x_lander, "beresheet": _x_lander,
}


PROCEDURAL = {
    f.__name__: f
    for f in (
        skylab,
        gaia,
        vanguard1,
        gps,
        luna2,
        sputnik1,
        sputnik2,
        ranger,
        lunar_orbiter,
        venera4,
        vega,
        mars3,
        phobos,
        fobosgrunt,
        mars96,
        salyut7,
        mex,
        venusexpress,
        tgo,
        schiaparelli,
        beagle2,
        solarorbiter,
        juice,
        smart1,
        change1,
        kaguya,
        chandrayaan1,
        chandrayaan2o,
        danuri,
        hayabusa2,
        hope,
        tianwen1,
        hakuto,
        beresheet,
        peregrine,
        luna25,
        tiangong,
        uars,
        pvo,
        akatsuki,
        marsobserver,
        mco,
        mpl,
        ds2,
    )
}


def main():
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--hd", required=True, help="the Almanac HD craft folder (hd/craft/): <key>.zcr2 and index.json")
    a = ap.parse_args()
    OUT = a.hd
    want = set(filter(None, a.only.split(",")))
    for key, fn in PROCEDURAL.items():
        if not want or key in want:
            m = fn()
            if key in EXTRAS:
                EXTRAS[key](m)
            m.write(key.replace("_", "-"))


if __name__ == "__main__":
    main()
