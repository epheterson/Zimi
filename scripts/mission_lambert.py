"""Lambert's problem by universal variables (Bate, Mueller and White, Fundamentals of Astrodynamics, algorithm 5.2): the orbit that
joins two positions in a given time. Units are the caller's (km, km^3/s^2, s). The JavaScript of the mission planner
(zimi/static/almanac-missions-plan.js) is this, line for line."""

import math

import numpy as np


def _stumpff(z):
    if z > 1e-6:
        s = math.sqrt(z)
        return (1 - math.cos(s)) / z, (s - math.sin(s)) / (s**3)
    if z < -1e-6:
        s = math.sqrt(-z)
        return (math.cosh(s) - 1) / (-z), (math.sinh(s) - s) / (s**3)
    return 0.5 - z / 24, 1 / 6 - z / 120


def lambert(r1, r2, tof, mu, prograde=True, normal=(0.0, 0.0, 1.0)):
    """Velocities (v1, v2) at r1 and r2 of the conic from r1 to r2 in `tof`, going the way `prograde` says about `normal`."""
    r1 = np.asarray(r1, float)
    r2 = np.asarray(r2, float)
    n1, n2 = np.linalg.norm(r1), np.linalg.norm(r2)
    c = np.dot(r1, r2) / (n1 * n2)
    dnu = math.acos(max(-1.0, min(1.0, c)))
    side = np.dot(np.cross(r1, r2), np.asarray(normal)) >= 0
    if prograde != side:
        dnu = 2 * math.pi - dnu
    A = math.sin(dnu) * math.sqrt(n1 * n2 / (1 - math.cos(dnu)))
    sq = math.sqrt(mu)

    def y_of(z):
        C, S = _stumpff(z)
        return n1 + n2 + A * (z * S - 1) / math.sqrt(C)

    def f(z):
        C, S = _stumpff(z)
        y = y_of(z)
        return (y / C) ** 1.5 * S + A * math.sqrt(y) - sq * tof

    hi = 4 * math.pi**2 - 1e-6
    lo = -50.0
    while y_of(lo) < 0 and lo < hi:  # y must be positive for the time of flight to mean anything
        lo += 0.05
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if y_of(mid) < 0 or f(mid) < 0:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-13:
            break
    z = 0.5 * (lo + hi)
    C, S = _stumpff(z)
    y = y_of(z)
    fl = 1 - y / n1
    g = A * math.sqrt(y / mu)
    gd = 1 - y / n2
    v1 = (r2 - fl * r1) / g
    v2 = (gd * r2 - r1) / g
    return v1, v2
