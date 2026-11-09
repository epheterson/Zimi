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
        tmp = "ms-tmp-" + name  # written under a name no site model has, then moved to craft-ms-<name>
        meta = bsm.write_zcrf(tmp, v, np.vstack(self.f), np.concatenate(self.c), self.palette)
        os.replace(os.path.join(EARTH, "craft-site-%s-v1.bin" % tmp), os.path.join(EARTH, "craft-ms-%s-v1.bin" % name))
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


def m_m20_heatshield():
    """Mars 2020's heat shield: a 70 degree sphere-cone 4.5 m across, 0.9 m deep (the aeroshell is MSL's, scaled to Mars 2020's lander)."""
    m = Stack([((0.45, 0.4, 0.38), 0.2, 12), ((0.2, 0.18, 0.18), 0.2, 10), ALU])
    m.ring(0.0, 0.5, 4.5 / 2, 4.5 / 2 * 0.97, 0)
    m.ring(0.5, 0.9, 4.5 / 2 * 0.97, 0.35, 0)
    m.disc(0.9, 0.35, 1)
    return m.save("m20-heatshield")


def m_m20_backshell():
    """The backshell: a cone 4.5 m across at the heat shield to 2.6 m, 2.1 m deep, white, with the parachute canister at its tip."""
    m = Stack([WHITE, ALU, DARK, ORANGE])
    m.ring(0.0, 2.1, 4.5 / 2, 1.3, 0)
    m.ring(2.1, 2.5, 1.3, 1.1, 1)
    m.disc(2.5, 1.1, 2)
    for a in (0, 90, 180, 270):
        ang = math.radians(a)
        m.box((1.9 * math.cos(ang), 0.5, 1.9 * math.sin(ang)), (0.3, 0.3, 0.3), 2)  # thrusters
    return m.save("m20-backshell")


def m_m20_cruise():
    """The cruise stage: a ring 3.4 m across carrying the solar array (dark blue, 6.5 m^2), tanks and antennas, 0.6 m deep."""
    m = Stack([ALU, ((0.04, 0.07, 0.22), 1.0, 80), DARK, GOLD])
    m.ring(0.0, 0.5, 3.4 / 2, 3.4 / 2, 1)
    m.disc(0.5, 3.4 / 2, 1)
    m.ring(-0.3, 0.0, 1.0, 1.0, 3)
    for a in (45, 135, 225, 315):
        ang = math.radians(a)
        m.cyl((0.9 * math.cos(ang), -0.35, 0.9 * math.sin(ang)), 0.25, 0.5, 0, n=8, axis="y")
    return m.save("m20-cruise")


def m_m20_descent():
    """The sky crane: the descent stage, an octagonal frame 2.7 m across with eight throttleable engines, the rover below on its bridles
    (the rover itself is the Perseverance model, placed by missions-v1.json)."""
    m = Stack([WHITE, ALU, DARK, GOLD])
    m.ring(0.0, 0.8, 2.7 / 2, 2.7 / 2, 0, n=8)
    m.disc(0.8, 2.7 / 2, 0, n=8)
    for a in range(0, 360, 45):
        ang = math.radians(a + 22.5)
        x, z = 1.0 * math.cos(ang), 1.0 * math.sin(ang)
        m.bell(x, z, -0.9, 0.22, 0.9, 2)
    return m.save("m20-descent")


def m_m20_parachute():
    """The supersonic parachute: a canopy 21.5 m across (shallow dome, orange and white) on its lines, laid out along y with the payload at 0."""
    m = Stack([ORANGE, WHITE, DARK, ALU])
    r = 21.5 / 2
    for i in range(8):
        a0, a1 = math.radians(i * 45), math.radians(i * 45 + 45)
        rows = []
        pts = lambda rr, y, a: np.array([rr * math.cos(a), y, rr * math.sin(a)])
        for k in range(4):
            r0, r1 = r * k / 4, r * (k + 1) / 4
            y0, y1 = 36 + 4 * math.sqrt(max(0, 1 - (k / 4) ** 2)) * 1.0, 36 + 4 * math.sqrt(max(0, 1 - ((k + 1) / 4) ** 2))
            m.add([pts(r0, y0, a0), pts(r1, y1, a0), pts(r1, y1, a1), pts(r0, y0, a1)], [(0, 1, 2), (0, 2, 3), (0, 2, 1), (0, 3, 2)], 0 if i % 2 == 0 else 1)
    for i in range(8):
        a = math.radians(i * 45)
        m.tube((0, 0, 0), (r * math.cos(a), 36, r * math.sin(a)), 0.03, 3, n=4)
    return m.save("m20-parachute")


BUILDERS.update({"m20-heatshield": m_m20_heatshield, "m20-backshell": m_m20_backshell, "m20-cruise": m_m20_cruise, "m20-descent": m_m20_descent, "m20-parachute": m_m20_parachute})


def _lm_ascent(m, z0):
    """The ascent stage on a descent stage whose top is at z0: the crew cabin and its engine cover, 4.3 m across, 2.8 m tall."""
    m.frustum((0, 0, z0), (0, 0, z0 + 2.2), 1.9, 1.7, 2, n=10)
    m.frustum((0, 0, z0 + 2.2), (0, 0, z0 + 2.8), 1.7, 1.0, 2, n=10)
    m.box((0, 1.5, z0 + 1.2), (1.5, 1.0, 1.1), 2)  # the front, with the windows
    m.box((0, 0, z0 + 3.0), (1.0, 1.0, 0.3), 1)
    m.tube((-1.4, -0.9, z0 + 2.9), (-1.4, -0.9, z0 + 4.8), 0.03, 1, n=4)  # antennas
    m.frustum((1.6, -0.6, z0 + 1.6), (3.0, -1.4, z0 + 2.6), 0.06, 0.06, 1, n=4, caps=False)
    for sx in (-1, 1):
        m.box((sx * 2.1, 0.0, z0 + 1.0), (0.5, 0.6, 0.5), 3)  # reaction control quads
        m.box((0, sx * 2.1, z0 + 1.0), (0.6, 0.5, 0.5), 3)


def m_lm_ascent():
    """The lunar module's ascent stage alone (what flew back to orbit): standing on z = 0, nose +y (the front hatch), 4.3 m across."""
    m = Stack([ALU, WHITE, DARK, GOLD])
    _lm_ascent(m, 0.0)
    return m.save("lm-ascent")


def m_lm():
    """The whole lunar module, legs out: a gold octagonal descent stage 4.2 m across and 1.65 m deep on four legs (9.4 m footpad to footpad),
    the ascent stage on top. Grumman LM Press Kit."""
    m = Stack([ALU, WHITE, DARK, GOLD])
    m.frustum((0, 0, 1.5), (0, 0, 3.15), 2.1, 2.1, 3, n=8)
    m.frustum((0, 0, 3.15), (0, 0, 3.2), 2.1, 2.1, 0, n=8)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        c, s_ = math.cos(a), math.sin(a)
        m.tube((1.9 * c, 1.9 * s_, 2.4), (4.7 * c, 4.7 * s_, 0.05), 0.09, 0, n=5)
        m.frustum((4.7 * c, 4.7 * s_, 0.2), (4.7 * c, 4.7 * s_, 0.05), 0.3, 0.45, 0, n=8)
        m.tube((1.9 * c, 1.9 * s_, 2.9), (4.2 * c, 4.2 * s_, 1.0), 0.04, 0, n=4)
    m.frustum((0, 0, 1.0), (0, 0, 1.5), 0.35, 0.7, 2, n=8, caps=False)  # the descent engine bell
    _lm_ascent(m, 3.2)
    return m.save("lm")


def m_csm():
    """The command and service modules together as they flew docked in space: the service module 3.9 m by 7.5 m with its engine bell, the command
    module on its nose, along y."""
    m = Stack([WHITE, ALU, DARK, GOLD])
    m.ring(0.0, 7.5, 3.9 / 2, 3.9 / 2, 0)
    m.ring(2.0, 2.4, 3.95 / 2, 3.95 / 2, 1)
    m.disc(7.5, 3.9 / 2, 1)
    m.bell(0, 0, -2.8, 1.25, 3.2, 2)
    m.ring(7.5, 10.4, 3.9 / 2, 0.8, 3)
    m.ring(10.4, 11.0, 0.8, 0.5, 1)
    m.box((0, 4.0, 2.0), (1.0, 3.5, 0.2), 2)
    m.tube((0, 11.0, 0), (0, 12.4, 0), 0.12, 1, n=6)  # the docking probe
    return m.save("csm")


BUILDERS.update({"lm-ascent": m_lm_ascent, "lm": m_lm, "csm": m_csm})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    names = [n for n in args.only.split(",") if n] or list(BUILDERS)
    for n in names:
        BUILDERS[n]()


if __name__ == "__main__":
    main()
