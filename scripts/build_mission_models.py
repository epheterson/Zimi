"""Build the vehicles the mission player flies: the Saturn V's stages and the Apollo spacecraft, the launchers of the other
missions, written from their published dimensions (the NASA 3D Resources library has no model of most of them).

    python scripts/build_mission_models.py [--only ms-sic,ms-sii]

Each is craft-ms-<name>-v1.bin in zimi/static/earth/ (ZCRF, as build_site_models.py writes it): metres, +y the way the
vehicle points, +z its up, the stage's own base at y = 0 and its axis on x = z = 0. A vehicle in missions-v1.json stacks
them by the offsets along y that the dimensions below give. Sources of the dimensions are in each function.
"""

import argparse
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_site_models as bsm  # noqa: E402

EARTH = bsm.EARTH

WHITE = ((0.86, 0.86, 0.84), 0.25, 18)
BLACK = ((0.03, 0.03, 0.035), 0.2, 14)
GREY = ((0.45, 0.45, 0.47), 0.3, 20)
ALU = ((0.62, 0.62, 0.64), 0.4, 30)
GOLD = ((0.62, 0.45, 0.12), 1.2, 60)
DARK = ((0.12, 0.12, 0.13), 0.2, 14)
ORANGE = ((0.78, 0.38, 0.12), 0.2, 14)
RED = ((0.6, 0.08, 0.08), 0.2, 14)


class Stack(bsm.Mesh):
    """bsm.Mesh with the y axis as the vehicle's: shapes along y, radii about it."""

    def ring(self, y0, y1, r0, r1, color, n=28):
        self.frustum((0, y0, 0), (0, y1, 0), r0, r1, color, n=n, caps=False)

    def disc(self, y, r, color, n=28):
        self.frustum((0, y, 0), (0, y + 1e-3, 0), r, r, color, n=n, caps=True)

    def bell(self, x, z, y, r, length, color=1):
        self.frustum(
            (x, y + length, z), (x, y, z), r * 0.35, r, color, n=10, caps=False
        )

    def fin(self, angle_deg, r, y0, y1, span, thick, color):
        """A fin standing out from the hull at an angle about the axis (swept: wide at the root, narrow at the tip)."""
        a = math.radians(angle_deg)
        d = np.array([math.cos(a), 0, math.sin(a)])
        p = lambda out, y: np.array([0, y, 0]) + d * out
        self.add(
            [
                p(r, y0),
                p(r + span, y0 + (y1 - y0) * 0.45),
                p(r + span, y0 + (y1 - y0) * 0.7),
                p(r, y1),
            ],
            [(0, 1, 2), (0, 2, 3)],
            color,
        )
        self.add(
            [
                p(r, y0),
                p(r, y1),
                p(r + span, y0 + (y1 - y0) * 0.7),
                p(r + span, y0 + (y1 - y0) * 0.45),
            ],
            [(0, 1, 2), (0, 2, 3)],
            color,
        )

    def save(self, name):
        v = np.vstack(self.v)
        meta = bsm.write_zcrf(
            name, v, np.vstack(self.f), np.concatenate(self.c), self.palette
        )
        src = os.path.join(EARTH, "craft-site-%s-v1.bin" % name)
        os.replace(src, os.path.join(EARTH, "craft-ms-%s-v1.bin" % name))
        return meta


def stripes(m, y0, y1, r, bands, color_a, color_b):
    """A cylinder painted in alternating bands (the S-IC's black and white)."""
    edges = np.linspace(y0, y1, bands + 1)
    for i in range(bands):
        m.ring(edges[i], edges[i + 1], r, r, color_a if i % 2 == 0 else color_b)


def m_sic():
    """Saturn V first stage with its fins and five F-1 engines. 10.06 m across, 42.1 m with the forward skirt (Saturn V
    Flight Manual SA-507). The roll-pattern: black and white bands (Apollo 11 flew the 'Rocketdyne' pattern).
    """
    r = 10.06 / 2
    m = Stack([WHITE, BLACK, ALU, DARK])
    stripes(m, 0.0, 33.0, r, 6, 0, 1)
    m.ring(33.0, 42.1, r, r, 0)
    m.disc(42.1, r, 0)
    m.ring(0.0, 1.2, r * 1.0, r * 0.97, 3)
    for a in (45, 135, 225, 315):
        m.fin(a, r, 0.0, 10.5, 3.7, 0.3, 1)
    for x, z in [(0, 0), (3.5, 0), (-3.5, 0), (0, 3.5), (0, -3.5)]:
        m.bell(x, z, -3.5, 1.9, 3.8, 3)
    return m.save("sic")


def m_sii():
    """Second stage with the interstage that joins it to the first: 10.06 m, 30.3 m (SA-507)."""
    r = 10.06 / 2
    m = Stack([WHITE, BLACK, ALU, DARK])
    m.ring(0.0, 5.5, r, r, 1)
    m.ring(5.5, 30.3, r, r, 0)
    m.disc(30.3, r, 0)
    for x, z in [(0, 0), (1.9, 0), (-1.9, 0), (0, 1.9), (0, -1.9)]:
        m.bell(x, z, -1.4, 0.95, 3.0, 2)
    return m.save("sii")


def m_sivb():
    """Third stage and the instrument unit: 6.6 m across, 17.8 m and 0.9 m (SA-507); the interstage flares to the second stage."""
    r = 6.6 / 2
    m = Stack([WHITE, BLACK, ALU, DARK])
    m.ring(-3.3, 0.0, 10.06 / 2 * 0.0 + r * 1.0, r, 0)
    m.ring(0.0, 17.8, r, r, 0)
    m.ring(17.8, 18.7, r, r, 1)
    m.bell(0, 0, -2.2, 0.97, 3.3, 2)
    return m.save("sivb")


def m_sla():
    """The spacecraft/LM adapter: the cone from the third stage's 6.6 m to the service module's 3.9 m, 8.5 m (SA-507)."""
    m = Stack([WHITE, BLACK, ALU, DARK])
    m.ring(0.0, 8.5, 6.6 / 2, 3.9 / 2, 0, n=28)
    return m.save("sla")


def m_sla_open():
    """The adapter with its four panels swung out, so the command module can pull the lunar module out."""
    m = Stack([WHITE, BLACK, ALU, DARK])
    m.ring(0.0, 1.5, 6.6 / 2, 6.6 / 2, 0, n=28)
    for a in (45, 135, 225, 315):
        ang = math.radians(a)
        d = np.array([math.cos(ang), 0, math.sin(ang)])
        t = np.array([-math.sin(ang), 0, math.cos(ang)])
        base = np.array([0, 1.5, 0]) + d * (6.6 / 2)
        tip = base + d * 6.5 + np.array([0, 6.0, 0])
        w = 2.6
        m.add(
            [base - t * w, base + t * w, tip + t * 0.9, tip - t * 0.9],
            [(0, 1, 2), (0, 2, 3), (0, 2, 1), (0, 3, 2)],
            0,
        )
    return m.save("sla-open")


def m_cm():
    """The Apollo command module: 3.9 m across the heat shield, 3.2 m long, a blunt cone (Apollo Operations Handbook)."""
    m = Stack([GREY, ALU, DARK, GOLD])
    m.ring(0.0, 0.5, 3.9 / 2, 3.9 / 2, 2)  # the heat shield's rim
    m.ring(0.5, 2.9, 3.9 / 2, 0.8, 0)
    m.ring(2.9, 3.2, 0.8, 0.45, 1)
    m.disc(0.0, 3.9 / 2, 3)
    return m.save("cm")


def m_sm():
    """The service module: 3.9 m across, 7.5 m long, with the engine bell (Apollo Operations Handbook)."""
    m = Stack([WHITE, ALU, DARK, GOLD])
    m.ring(0.0, 7.5, 3.9 / 2, 3.9 / 2, 0)
    m.ring(2.0, 2.4, 3.9 / 2 + 0.02, 3.9 / 2 + 0.02, 2)
    m.disc(7.5, 3.9 / 2, 1)
    m.bell(0, 0, -2.8, 1.25, 3.2, 1)
    m.box((0, 5.2, 2.0), (0.9, 3.0, 0.2), 1)
    return m.save("sm")


def m_let():
    """The launch escape tower and the boost protective cover: 10.2 m (Apollo Operations Handbook)."""
    m = Stack([WHITE, ALU, DARK, ORANGE])
    m.ring(0.0, 3.2, 3.9 / 2, 1.0, 0)
    m.frustum((0, 3.2, 0), (0, 4.0, 0), 1.0, 0.7, 2, n=12, caps=False)
    for a in (0, 90, 180, 270):
        ang = math.radians(a)
        x, z = 0.5 * math.cos(ang), 0.5 * math.sin(ang)
        m.frustum((x, 4.0, z), (x, 10.2, z), 0.12, 0.12, 2, n=6, caps=False)
    m.ring(4.4, 7.4, 0.48, 0.48, 1, n=12)
    m.frustum((0, 7.4, 0), (0, 10.2, 0), 0.48, 0.05, 3, n=12, caps=False)
    return m.save("let")


BUILDERS = {
    "sic": m_sic,
    "sii": m_sii,
    "sivb": m_sivb,
    "sla": m_sla,
    "sla-open": m_sla_open,
    "cm": m_cm,
    "sm": m_sm,
    "let": m_let,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    names = [n for n in args.only.split(",") if n] or list(BUILDERS)
    for n in names:
        BUILDERS[n]()


if __name__ == "__main__":
    main()
