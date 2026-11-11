"""Voyager's Golden Record sits centred on its plate and fills it, as on the craft.

The plate is the round white part (shading class 5) on the +x face of NASA's model in zimi/static/earth/craft-voyager-v1.bin;
its face is a circle in y, z that is fitted here to the model's own vertices and compared with AE_CRAFT_RECORD in the page.
No browser: the file's format is documented in scripts/build_craft_models.py.

Run: pytest tests/test_almanac_craft_record.py -v
"""

import math
import os
import re
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATE_CLASS = 5  # the plate's own shading entry in the voyager palette
TOLERANCE_M = 0.01


def _plate_vertices():
    """The plate's face vertices (metres, in the model's frame centred on its box)."""
    with open(
        os.path.join(ROOT, "zimi", "static", "earth", "craft-voyager-v1.bin"), "rb"
    ) as fh:
        b = fh.read()
    f = lambda o: struct.unpack_from("<f", b, o)[0]  # noqa: E731
    metres = f(8)
    lo = [f(12), f(16), f(20)]
    hi = [f(24), f(28), f(32)]
    mid = [(lo[k] + hi[k]) / 2 for k in range(3)]
    palette = struct.unpack_from("<I", b, 60)[0]
    o = 64 + 20 * palette
    nv = struct.unpack_from("<I", b, o)[0]
    o += 8
    out = []
    for _ in range(nv):
        q = struct.unpack_from("<3h", b, o)
        if b[o + 6] == PLATE_CLASS:
            out.append(
                [
                    (lo[k] + (q[k] + 32767) / 65534 * (hi[k] - lo[k]) - mid[k]) * metres
                    for k in range(3)
                ]
            )
        o += 8
    return out


def _fit_circle(points):
    """Least squares circle through (y, z) points: centre and radius, by the normal equations of x^2 + y^2 = 2ax + 2by + c."""
    n = len(points)
    sy = sum(p[0] for p in points)
    sz = sum(p[1] for p in points)
    syy = sum(p[0] ** 2 for p in points)
    szz = sum(p[1] ** 2 for p in points)
    syz = sum(p[0] * p[1] for p in points)
    r1 = sum(p[0] * (p[0] ** 2 + p[1] ** 2) for p in points)
    r2 = sum(p[1] * (p[0] ** 2 + p[1] ** 2) for p in points)
    r3 = sum(p[0] ** 2 + p[1] ** 2 for p in points)
    m = [[2 * syy, 2 * syz, sy], [2 * syz, 2 * szz, sz], [2 * sy, 2 * sz, n]]
    rhs = [r1, r2, r3]

    def det(a):
        return (
            a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
            - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
            + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
        )

    d = det(m)
    sol = []
    for col in range(3):
        mm = [row[:] for row in m]
        for r in range(3):
            mm[r][col] = rhs[r]
        sol.append(det(mm) / d)
    return sol[0], sol[1], math.sqrt(sol[2] + sol[0] ** 2 + sol[1] ** 2)


def test_the_record_is_centred_on_its_plate_and_fills_it():
    src = open(
        os.path.join(ROOT, "zimi", "static", "almanac-earth.js"), encoding="utf-8"
    ).read()
    m = re.search(
        r"AE_CRAFT_RECORD = \{ voyager: \{ at: \[([-\d.]+), ([-\d.]+), ([-\d.]+)\], r: ([\d.]+) \} \}",
        src,
    )
    assert m, "AE_CRAFT_RECORD voyager"
    x, y, z, r = (float(g) for g in m.groups())
    face = [
        p for p in _plate_vertices() if p[0] > 1.25
    ]  # the plate's face, not its rim
    assert len(face) > 20, len(face)
    cy, cz, radius = _fit_circle([(p[1], p[2]) for p in face])
    assert abs(y - cy) < TOLERANCE_M and abs(z - cz) < TOLERANCE_M, ((y, z), (cy, cz))
    assert abs(r - radius) < TOLERANCE_M, (r, radius)
    assert x > max(p[0] for p in face) - 1e-3  # on the face, not behind it
