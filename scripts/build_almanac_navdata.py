#!/usr/bin/env python3
"""Build zimi/static/almanac-navdata.js: the data behind the Almanac's
Nautical Almanac pages (zimi/static/almanac-reference.js).

Two tables, both written once and never refreshed: the point is that they
keep working with no new data, ever.

Planets: VSOP87, version D (Bretagnon & Francou 1988; heliocentric ecliptic
coordinates of the date), CDS catalogue VI/81, for Venus, Mars, Jupiter and
Saturn. The full series runs to thousands of terms; every term is kept whose
amplitude, times |tau|^power at tau = 0.5 (the years 1500 and 2500), is at
least TRUNCATE (3e-6 rad or AU). Measured against the full series, geocentric,
light-time corrected, at 120 random instants 1600-2400: Venus 7.9", Mars
7.7", Jupiter 5.5", Saturn 5.1" at worst, inside the Nautical Almanac's own
0.1' printing. The Earth comes from almanac-earth.js (the same series,
truncated the same way, already shipped for the Sun).

Stars: the 57 navigational stars of the Nautical Almanac, plus Polaris, from
the Hipparcos new reduction (van Leeuwen 2007, CDS I/311) by HIP number:
position at J1991.25, proper motion, parallax. Radial velocities from the Yale
Bright Star Catalogue, 5th ed. (CDS V/50). The positions are carried to J2000
here with the same space-motion propagation the browser uses from J2000 on.

Run: python3 scripts/build_almanac_navdata.py   (needs the network, once)
"""

import hashlib
import math
import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "almanac-navdata.js")

VSOP_URL = "https://cdsarc.cds.unistra.fr/ftp/VI/81/VSOP87D.{}"
VSOP_SHA256 = {
    "ven": "cb2f3a738289ed45f69fec1845e480baf4b32d481eccc21b8629a2d0d10e8261",
    "mar": "b1184df9553d85ffcf904c16bd437ab668804fa98859f27fe2e7bf6cfa6bc07e",
    "jup": "3f3dfbc7d117ecad2b2dadf2fc626b260a3cd5efa98e7d4c6b26cd682fc48090",
    "sat": "2e49e19396f24c17298f0b667e7763ee5c28b60d549c89d72a17dfd5f8d46b05",
}
PLANETS = (("venus", "ven"), ("mars", "mar"), ("jupiter", "jup"), ("saturn", "sat"))
TRUNCATE = 3e-6
TAU_MAX = 0.5

HIP2_URL = (
    "https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/311/hip2"
    "&-out=HIP,RArad,DErad,pmRA,pmDE,Plx&-out.max=200&HIP={}"
)
HIP2_EPOCH = 1991.25
# Nautical Almanac number, name, HIP, V magnitude (Hipparcos), radial
# velocity km/s (BSC5). 0 is Polaris, which the Almanac tables apart.
STARS = [
    (1, "Alpheratz", 677, 2.07, -12),
    (2, "Ankaa", 2081, 2.4, 75),
    (3, "Schedar", 3179, 2.24, -4),
    (4, "Diphda", 3419, 2.04, 13),
    (5, "Achernar", 7588, 0.45, 16),
    (6, "Hamal", 9884, 2.01, -14),
    (7, "Acamar", 13847, 2.88, 12),
    (8, "Menkar", 14135, 2.54, -26),
    (9, "Mirfak", 15863, 1.79, -2),
    (10, "Aldebaran", 21421, 0.87, 54),
    (11, "Rigel", 24436, 0.18, 21),
    (12, "Capella", 24608, 0.08, 30),
    (13, "Bellatrix", 25336, 1.64, 18),
    (14, "Elnath", 25428, 1.65, 9),
    (15, "Alnilam", 26311, 1.69, 26),
    (16, "Betelgeuse", 27989, 0.45, 21),
    (17, "Canopus", 30438, -0.62, 21),
    (18, "Sirius", 32349, -1.44, -8),
    (19, "Adhara", 33579, 1.5, 27),
    (20, "Procyon", 37279, 0.4, -3),
    (21, "Pollux", 37826, 1.16, 3),
    (22, "Avior", 41037, 1.86, 2),
    (23, "Suhail", 44816, 2.23, 18),
    (24, "Miaplacidus", 45238, 1.67, -5),
    (25, "Alphard", 46390, 1.99, -4),
    (26, "Regulus", 49669, 1.36, 6),
    (27, "Dubhe", 54061, 1.81, -9),
    (28, "Denebola", 57632, 2.14, 0),
    (29, "Gienah", 59803, 2.58, -4),
    (30, "Acrux", 60718, 0.77, -11),
    (31, "Gacrux", 61084, 1.59, 21),
    (32, "Alioth", 62956, 1.76, -9),
    (33, "Spica", 65474, 0.98, 1),
    (34, "Alkaid", 67301, 1.85, -11),
    (35, "Hadar", 68702, 0.61, 6),
    (36, "Menkent", 68933, 2.06, 1),
    (37, "Arcturus", 69673, -0.05, -5),
    (38, "Rigil Kentaurus", 71683, -0.01, -22),
    (39, "Zubenelgenubi", 72622, 2.75, -10),
    (40, "Kochab", 72607, 2.07, 17),
    (41, "Alphecca", 76267, 2.22, 2),
    (42, "Antares", 80763, 1.06, -3),
    (43, "Atria", 82273, 1.91, -3),
    (44, "Sabik", 84012, 2.43, -1),
    (45, "Shaula", 85927, 1.62, -3),
    (46, "Rasalhague", 86032, 2.08, 13),
    (47, "Eltanin", 87833, 2.24, -28),
    (48, "Kaus Australis", 90185, 1.79, -15),
    (49, "Vega", 91262, 0.03, -14),
    (50, "Nunki", 92855, 2.05, -11),
    (51, "Altair", 97649, 0.76, -26),
    (52, "Peacock", 100751, 1.94, 2),
    (53, "Deneb", 102098, 1.25, -5),
    (54, "Enif", 107315, 2.38, 5),
    (55, "Al Na'ir", 109268, 1.73, 12),
    (56, "Fomalhaut", 113368, 1.17, 7),
    (57, "Markab", 113963, 2.49, -4),
    (0, "Polaris", 11767, 1.97, -17),
]
# One astronomical unit per Julian year, in km/s: converts a radial velocity
# into the same units as proper motion times distance.
KMS_PER_AU_PER_YEAR = 149597870.7 / (365.25 * 86400)


def _get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def vsop_series(code):
    raw = _get(VSOP_URL.format(code))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != VSOP_SHA256[code]:
        raise SystemExit(f"VSOP87D.{code}: sha256 {digest} is not the pinned one")
    series = {1: {}, 2: {}, 3: {}}
    cur = None
    for line in raw.decode("ascii").splitlines():
        if "VSOP87" in line:
            m = re.search(r"VARIABLE (\d).*\*T\*\*(\d)", line)
            cur = series[int(m.group(1))].setdefault(int(m.group(2)), [])
            continue
        a, b, c = (float(x) for x in line.split()[-3:])
        cur.append((a, b, c))
    out = {}
    for var, key in ((1, "L"), (2, "B"), (3, "R")):
        rows = []
        for power in sorted(series[var]):
            rows.append(
                [t for t in series[var][power] if t[0] * TAU_MAX**power >= TRUNCATE]
            )
        while rows and not rows[-1]:
            rows.pop()
        out[key] = rows
    return out


def _fmt(x, digits):
    s = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def js_series(rows):
    parts = []
    for row in rows:
        flat = ",".join(f"{_fmt(a, 11)},{_fmt(b, 8)},{_fmt(c, 6)}" for a, b, c in row)
        parts.append("[" + flat + "]")
    return "[" + ",".join(parts) + "]"


def star_rows():
    hips = ",".join(str(s[2]) for s in STARS)
    text = _get(HIP2_URL.format(hips)).decode("ascii")
    astrom = {}
    for line in text.splitlines():
        cols = line.split("\t")
        if len(cols) >= 6 and cols[0].strip().isdigit():
            astrom[int(cols[0])] = [float(c) for c in cols[1:6]]
    rows = []
    for num, name, hip, vmag, rv in STARS:
        ra, dec, pmra, pmde, plx = astrom[hip]
        ra2, dec2 = propagate(ra, dec, pmra, pmde, plx, rv, 2000.0 - HIP2_EPOCH)
        rows.append((num, name, ra2, dec2, pmra, pmde, plx, rv, vmag))
    return rows


def propagate(ra, dec, pmra, pmde, plx, rv, years):
    """Space motion, straight-line: the browser's _arStarJ2000ToDate twin."""
    a, d = math.radians(ra), math.radians(dec)
    u = (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))
    east = (-math.sin(a), math.cos(a), 0.0)
    north = (-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d))
    mas = math.radians(1 / 3600000)
    radial = rv / KMS_PER_AU_PER_YEAR * plx * mas  # rad/yr, as distance fraction
    v = [pmra * mas * east[i] + pmde * mas * north[i] + radial * u[i] for i in range(3)]
    p = [u[i] + v[i] * years for i in range(3)]
    r = math.sqrt(sum(x * x for x in p))
    return (
        math.degrees(math.atan2(p[1], p[0])) % 360,
        math.degrees(math.asin(p[2] / r)),
    )


def main():
    lines = [
        "// GENERATED by scripts/build_almanac_navdata.py: do not edit by hand.",
        "// VSOP87D (CDS VI/81) truncated at 3e-6 for 1500-2500, and the 57",
        "// navigational stars + Polaris from Hipparcos (CDS I/311) at J2000.",
        "// Each VSOP row is flat [A, B, C, A, B, C, ...] for A cos(B + C tau).",
        "var AR_VSOP = {",
    ]
    for i, (name, code) in enumerate(PLANETS):
        s = vsop_series(code)
        sep = "," if i < len(PLANETS) - 1 else ""
        lines.append(
            f"  {name}: {{ L: {js_series(s['L'])},\n    B: {js_series(s['B'])},\n"
            f"    R: {js_series(s['R'])} }}{sep}"
        )
    lines.append("};")
    lines.append(
        "// [Almanac no., name, RA deg, Dec deg (ICRS, J2000), pm RA cos Dec, pm Dec"
        " (mas/yr), parallax (mas), radial velocity (km/s), V]"
    )
    lines.append("var AR_NAV_STARS = [")
    rows = star_rows()
    for i, r in enumerate(rows):
        sep = "," if i < len(rows) - 1 else ""
        name = r[1].replace("'", "\\'")
        lines.append(
            f"  [{r[0]},'{name}',{r[2]:.7f},{r[3]:.7f},{_fmt(r[4], 2)},{_fmt(r[5], 2)},"
            f"{_fmt(r[6], 2)},{r[7]},{r[8]}]{sep}"
        )
    lines.append("];")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
