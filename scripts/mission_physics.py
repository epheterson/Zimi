"""The physics the mission tables are built from: frames, gravity, JPL Horizons, finite burns.

Used by scripts/build_missions.py (never shipped, never run by Zimi). Units are km, km/s and seconds from a mission's
own zero, in the J2000 ecliptic frame JPL Horizons and the Almanac's ephemerides share; a body-fixed frame is named.

    Earth   mu 398600.4418 km^3/s^2, radius 6378.137 km, flattening 1/298.257223563, J2 1.08262668e-3 (WGS84 / EGM)
    Moon    mu 4902.800066 km^3/s^2, radius 1737.4 km (IAU)
    Sun     mu 132712440041.94 km^3/s^2 (DE440)
    Frames  IAU 1976 precession, mean sidereal time (IAU 1982), IAU 2009 lunar rotation (Archinal et al. 2011)
"""

import json
import math
import os
import re
import urllib.parse
import urllib.request

import numpy as np

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
CACHE = os.environ.get(
    "MISSIONS_CACHE", os.path.join(os.path.expanduser("~"), ".cache", "zimi-missions")
)

MU_EARTH = 398600.4418
R_EARTH = 6378.137
F_EARTH = 1 / 298.257223563
J2_EARTH = 1.08262668e-3
OMEGA_EARTH = 7.2921159e-5
MU_MOON = 4902.800066
R_MOON = 1737.4
MU_SUN = 132712440041.94
G0 = 9.80665
AU_KM = 149597870.7
OBLIQUITY = math.radians(84381.448 / 3600)
JD_J2000 = 2451545.0


# ── Vectors ──
def rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def unit(v):
    return v / np.linalg.norm(v)


# ── Time ──
def jd_of(y, mo, d, h=0, mi=0, s=0.0):
    if mo <= 2:
        y, mo = y - 1, mo + 12
    a = y // 100
    b = 2 - a + a // 4
    return (
        int(365.25 * (y + 4716))
        + int(30.6001 * (mo + 1))
        + d
        + b
        - 1524.5
        + (h + mi / 60 + s / 3600) / 24
    )


def gmst(jd_ut):
    """Mean sidereal time (rad), IAU 1982."""
    t = (jd_ut - JD_J2000) / 36525
    d = jd_ut - JD_J2000
    deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - t**3 / 38710000
    return math.radians(deg % 360)


# ── Frames: ecliptic J2000 <-> equator J2000 <-> mean equator of date <-> Earth-fixed ──
def ecl_to_eq():
    return rx(OBLIQUITY)


def eq_to_ecl():
    return rx(-OBLIQUITY)


def precession(jd):
    """J2000 equatorial -> mean equator of date (IAU 1976)."""
    t = (jd - JD_J2000) / 36525
    s = math.radians(1 / 3600)
    zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t**3) * s
    z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t**3) * s
    theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t**3) * s
    return rz(z) @ ry(-theta) @ rz(zeta)  # the passive R3(-z) R2(theta) R3(-zeta); rx, ry, rz here turn a vector


def ecef_to_ecl(jd_ut):
    """Earth-fixed -> ecliptic J2000 (no nutation, no polar motion: under a kilometre)."""
    return eq_to_ecl() @ precession(jd_ut).T @ rz(gmst(jd_ut))


def earth_pole_ecl(jd_ut):
    return eq_to_ecl() @ precession(jd_ut).T @ np.array([0.0, 0.0, 1.0])


def geodetic_to_ecef(lat_deg, lon_deg, alt_km=0.0):
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    e2 = F_EARTH * (2 - F_EARTH)
    n = R_EARTH / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return np.array(
        [
            (n + alt_km) * math.cos(lat) * math.cos(lon),
            (n + alt_km) * math.cos(lat) * math.sin(lon),
            (n * (1 - e2) + alt_km) * math.sin(lat),
        ]
    )


def ecef_to_geodetic(p):
    x, y, z = p
    lon = math.atan2(y, x)
    e2 = F_EARTH * (2 - F_EARTH)
    r = math.hypot(x, y)
    lat = math.atan2(z, r * (1 - e2))
    for _ in range(6):
        n = R_EARTH / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        alt = (
            r / math.cos(lat) - n
            if abs(lat) < 1.4
            else z / math.sin(lat) - n * (1 - e2)
        )
        lat = math.atan2(z, r * (1 - e2 * n / (n + alt)))
    return math.degrees(lat), math.degrees(lon), alt


def moon_rotation(jd_tdb):
    """ICRF/J2000 equatorial -> Moon-fixed (mean Earth / polar axis), IAU 2009 (Archinal et al. 2011)."""
    d = jd_tdb - JD_J2000
    t = d / 36525
    e = [
        (125.045, -0.0529921),
        (250.089, -0.1059842),
        (260.008, 13.0120009),
        (176.625, 13.3407154),
        (357.529, 0.9856003),
        (311.589, 26.4057084),
        (134.963, 13.0649930),
        (276.617, 0.3287146),
        (34.226, 1.7484877),
        (15.134, -0.1589763),
        (119.743, 0.0036096),
        (239.961, 0.1643573),
        (25.053, 12.9590088),
    ]
    s = [math.sin(math.radians(a + b * d)) for a, b in e]
    c = [math.cos(math.radians(a + b * d)) for a, b in e]
    ra = (
        269.9949
        + 0.0031 * t
        - 3.8787 * s[0]
        - 0.1204 * s[1]
        + 0.0700 * s[2]
        - 0.0172 * s[3]
        + 0.0072 * s[5]
        - 0.0052 * s[9]
        + 0.0043 * s[12]
    )
    dec = (
        66.5392
        + 0.0130 * t
        + 1.5419 * c[0]
        + 0.0239 * c[1]
        - 0.0278 * c[2]
        + 0.0068 * c[3]
        - 0.0029 * c[5]
        + 0.0009 * c[6]
        + 0.0008 * c[9]
        - 0.0009 * c[12]
    )
    w = (
        38.3213
        + 13.17635815 * d
        - 1.4e-12 * d * d
        + 3.5610 * s[0]
        + 0.1208 * s[1]
        - 0.0642 * s[2]
        + 0.0158 * s[3]
        + 0.0252 * s[4]
        - 0.0066 * s[5]
        - 0.0047 * s[6]
        - 0.0046 * s[7]
        + 0.0028 * s[8]
        + 0.0052 * s[9]
        + 0.0040 * s[10]
        + 0.0019 * s[11]
        - 0.0044 * s[12]
    )
    return rz(-math.radians(w)) @ rx(-math.radians(90 - dec)) @ rz(-math.radians(90 + ra))  # passive R3(W) R1(90-dec) R3(90+ra)


def moon_fixed_to_ecl(jd_tdb):
    return eq_to_ecl() @ moon_rotation(jd_tdb).T


def lunar_to_xyz(lat_deg, lon_deg, alt_km=0.0):
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    r = R_MOON + alt_km
    return np.array(
        [
            r * math.cos(lat) * math.cos(lon),
            r * math.cos(lat) * math.sin(lon),
            r * math.sin(lat),
        ]
    )


def xyz_to_lunar(p):
    r = np.linalg.norm(p)
    return (
        math.degrees(math.asin(p[2] / r)),
        math.degrees(math.atan2(p[1], p[0])),
        r - R_MOON,
    )


# ── JPL Horizons (UT times, km and km/s, ecliptic J2000) ──
def horizons(command, start, stop, step, center="500@399"):
    """Rows [jd_ut, x, y, z, vx, vy, vz] (km, km/s) of one Horizons VECTORS table; cached on disk by query."""
    q = {
        "format": "text",
        "COMMAND": "'%s'" % command,
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'",
        "CENTER": "'%s'" % center,
        "START_TIME": "'%s'" % start,
        "STOP_TIME": "'%s'" % stop,
        "STEP_SIZE": "'%s'" % step,
        "TIME_TYPE": "'UT'",
        "REF_PLANE": "'ECLIPTIC'",
        "VEC_TABLE": "'2'",
        "OUT_UNITS": "'KM-S'",
        "CSV_FORMAT": "'YES'",
        "VEC_LABELS": "'NO'",
    }
    url = HORIZONS + "?" + urllib.parse.urlencode(q)
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(
        CACHE,
        re.sub(
            r"[^A-Za-z0-9_.-]+",
            "_",
            "%s_%s_%s_%s_%s" % (command, center, start, stop, step),
        )
        + ".json",
    )
    if os.path.exists(path):
        with open(path) as fh:
            return np.array(json.load(fh))
    text = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                text = r.read().decode()
            break
        except OSError:
            if attempt == 3:
                raise
    m = re.search(r"\$\$SOE(.*?)\$\$EOE", text, re.S)
    if not m:
        raise RuntimeError(
            "Horizons gave no table for %s %s..%s:\n%s"
            % (command, start, stop, text[:500])
        )
    rows = []
    for line in m.group(1).strip().splitlines():
        f = [v.strip() for v in line.split(",") if v.strip()]
        rows.append([float(f[0])] + [float(v) for v in f[2:8]])
    with open(path, "w") as fh:
        json.dump(rows, fh)
    return np.array(rows)


class Ephemeris:
    """A body's place from a Horizons table by cubic Hermite interpolation; time is seconds from `t0_jd`."""

    def __init__(self, rows, t0_jd):
        from scipy.interpolate import CubicHermiteSpline

        self.t = (rows[:, 0] - t0_jd) * 86400.0
        self.p = rows[:, 1:4]
        self.v = rows[:, 4:7]
        self._spl = CubicHermiteSpline(self.t, self.p, self.v)
        self._dspl = self._spl.derivative()

    def state(self, t):
        return self._spl(t), self._dspl(t)

    def pos(self, t):
        return self._spl(t)


# ── Orbits ──
def elements(r, v, mu):
    """a, e, i (deg), perigee and apogee radius, from a state."""
    rn, vn = np.linalg.norm(r), np.linalg.norm(v)
    h = np.cross(r, v)
    ev = np.cross(v, h) / mu - r / rn
    e = np.linalg.norm(ev)
    a = 1 / (2 / rn - vn * vn / mu)
    inc = math.degrees(math.acos(h[2] / np.linalg.norm(h)))
    return {"a": a, "e": e, "inc": inc, "rp": a * (1 - e), "ra": a * (1 + e), "h": h}


def inclination_to(r, v, pole):
    h = np.cross(r, v)
    return math.degrees(math.acos(np.dot(h, pole) / np.linalg.norm(h)))
