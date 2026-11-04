#!/usr/bin/env python3
"""Fit the mean circular orbits almanac-space.js draws the major moons on.

    python3 scripts/fit_moon_orbits.py

Needs the internet (JPL Horizons) and prints the SP_MOONS table, in the form
it has in zimi/static/almanac-space.js so it pastes over it, with how far a mean circular orbit strays
from Horizons over 1990-2060. Each moon is taken relative to its planet in the
J2000 ecliptic frame, turned into the planet's equatorial plane (the IAU pole
below), and its angle in that plane is fitted as lambda0 + n * (JD - J2000)
by least squares. The radius is the mean distance. Eccentricity is left out:
the moons are drawn on mean orbits and the page says so.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_space_tracks import horizons  # noqa: E402

J2000 = 2451545.0
OBLIQUITY = math.radians(23.4392911)
AU_KM = 149597870.7
# IAU WGCCRE 2015 north poles (right ascension, declination of date J2000, degrees).
POLES = {"Jupiter": (268.056595, 64.495303), "Saturn": (40.589, 83.537)}
# The last column is the published mean motion (deg/day), only to unwrap the
# angle across 2-day samples; the fit replaces it.
MOONS = [
    ("Io", "501", "599", "Jupiter", 203.4889),
    ("Europa", "502", "599", "Jupiter", 101.3747),
    ("Ganymede", "503", "599", "Jupiter", 50.3176),
    ("Callisto", "504", "599", "Jupiter", 21.5711),
    ("Titan", "606", "699", "Saturn", 22.5770),
]


def equatorial_to_ecliptic(v):
    c, s = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
    return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]]


def pole_ecliptic(ra, dec):
    ra, dec = math.radians(ra), math.radians(dec)
    return equatorial_to_ecliptic(
        [math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)]
    )


def cross(a, b):
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(a):
    m = math.sqrt(dot(a, a))
    return [x / m for x in a]


def fit(name, cmd, center, planet, seed):
    rows = horizons(cmd, "1990-01-01", "2060-01-01", "2d", center="500@" + center)
    z = pole_ecliptic(*POLES[planet])
    x = norm(cross([0, 0, 1], z))  # the plane's ascending node on the ecliptic
    y = cross(z, x)
    ts, lams, rs = [], [], []
    seed_rate = math.radians(seed)
    for r in rows:
        p = r[1:4]
        t = r[0] - J2000
        lam = math.atan2(dot(p, y), dot(p, x))
        pred = seed_rate * t + (lams[0] - seed_rate * ts[0] if lams else lam)
        lam = pred + (lam - pred + math.pi) % (2 * math.pi) - math.pi
        ts.append(t)
        lams.append(lam)
        rs.append(math.sqrt(dot(p, p)))
    n = len(ts)
    mt, ml = sum(ts) / n, sum(lams) / n
    rate = sum((t - mt) * (l - ml) for t, l in zip(ts, lams)) / sum(
        (t - mt) ** 2 for t in ts
    )
    lam0 = ml - rate * mt
    worst = max(abs(l - (lam0 + rate * t)) for t, l in zip(ts, lams))
    a_km = sum(rs) / n * AU_KM
    return {
        "name": name,
        "planet": planet,
        "a_km": a_km,
        "lam0": math.degrees(lam0) % 360,
        "deg_per_day": math.degrees(rate),
        "worst_deg": math.degrees(worst),
    }


# IAU mean radii (km), the `r` of each SP_MOONS row.
RADIUS_KM = {"Io": 1821.6, "Europa": 1560.8, "Ganymede": 2634.1, "Callisto": 2410.3, "Titan": 2574.7}


def main():
    print("var SP_MOONS = {   // paste over the rows in zimi/static/almanac-space.js (the Moon's row is the Earth view's Meeus series)")
    for name, cmd, center, planet, seed in MOONS:
        f = fit(name, cmd, center, planet, seed)
        print(
            "  %s: { planet: '%s', a: %.0f, L0: %.3f, rate: %.6f, r: %s },   // worst miss %.1f deg"
            % (name, planet, f["a_km"], f["lam0"], f["deg_per_day"], RADIUS_KM[name], f["worst_deg"])
        )
    print("  Moon: { planet: 'Earth', a: 384400, r: 1737.4 }\n};")


if __name__ == "__main__":
    main()
