"""Turning integrated paths into the compact tables missions-v1.json ships: rows [t, x, y, z, vx, vy, vz] thinned so that a cubic
Hermite curve through the kept rows reproduces every dense row to a tolerance, as scripts/build_space_tracks.py does for the
probes."""

import numpy as np


def _hermite(a, b, t):
    h = b[0] - a[0]
    u = (t - a[0]) / h
    u2, u3 = u * u, u**3
    h00, h10, h01, h11 = 2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2
    return h00 * a[1:4] + h10 * h * a[4:7] + h01 * b[1:4] + h11 * h * b[4:7]


def thin(rows, tol, max_gap=None):
    """Keep the first row, then the farthest next row for which Hermite through the two keeps every dense row between
    within `tol` (the rows' length unit). `max_gap`: never keep two rows further apart than this many seconds.
    """
    rows = np.asarray(rows, dtype=float)
    keep = [0]
    i = 0
    n = len(rows)
    while i < n - 1:
        best = i + 1
        j = i + 2
        while j < n:
            if max_gap and rows[j, 0] - rows[i, 0] > max_gap:
                break
            ok = True
            for k in range(i + 1, j):
                if (
                    np.linalg.norm(
                        _hermite(rows[i], rows[j], rows[k, 0]) - rows[k, 1:4]
                    )
                    > tol
                ):
                    ok = False
                    break
            if not ok:
                break
            best = j
            j += 1
        keep.append(best)
        i = best
    return rows[keep]


def pack(rows, pos=4, vel=7):
    """Rows as JSON lists: time in tenths of a second, positions to `pos` decimals, velocities to `vel`."""
    out = []
    for r in rows:
        out.append(
            [round(float(r[0]), 2)]
            + [round(float(x), pos) for x in r[1:4]]
            + [round(float(x), vel) for x in r[4:7]]
            + [round(float(x), 4) for x in r[7:]]
        )
    return out
