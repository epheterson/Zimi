"""Perseverance's launch and cruise (slice 2): Atlas V 541 from Space Launch Complex 41 on 2020-07-30 11:50:00 UT as a profile through the published events, the parking
orbit and the Mars injection joined to JPL Horizons' own table of the spacecraft (-168: Earth-centred from 12:52, then Sun-centred for the 203 days to Mars).

It follows the launch's published events; it is not a simulated ascent. The altitude and speed between the events, the launch azimuth, the parking orbit and the burn's
shape are assumed (the burn is a Hermite arc from the parking orbit to Horizons' first state), and the reference says so.
"""

import math

import numpy as np

from mission_perseverance import LAUNCH, jd_unix
from mission_physics import MU_EARTH, R_EARTH, ecef_to_ecl, geodetic_to_ecef, horizons
from mission_tables import pack, thin

PAD = (28.5833, -80.5828)  # Space Launch Complex 41
AZIMUTH_DEG = 93.0  # assumed launch heading, east of north
OMEGA_EARTH = 7.2921159e-5
AU_KM = 149597870.7
STACK_H = 46.7  # the payload's base above the core's base: core 32.5 + the Centaur's skirt and body 14.2 (Atlas V Launch Services User's Guide)

# Seconds after liftoff: the events (published for the 541 launches in general; the times are this launch's as the press kit and the broadcast had them, to the nearest few
# seconds) and the altitude (km) and Earth-fixed speed (m/s) through them.
EV = {
    "srb_sep": 110.0,
    "fairing": 205.0,
    "meco": 270.0,
    "centaur1": 280.0,
    "orbit": 640.0,
    "sc_sep": 3400.0,
}
PROFILE = [
    (0.0, 0.0, 0.0),
    (30.0, 3.0, 150.0),
    (60.0, 11.0, 420.0),
    (110.0, 45.0, 1400.0),
    (205.0, 105.0, 2300.0),
    (270.0, 135.0, 3300.0),
    (400.0, 170.0, 5200.0),
    (550.0, 188.0, 6800.0),
    (640.0, 190.0, 7380.0),
]
T_ORBIT = EV["orbit"]


def _interp(ts, ys, t):
    from scipy.interpolate import PchipInterpolator

    return float(PchipInterpolator(ts, ys)(t))


def launch_rows(step=2.0):
    """Earth-fixed rows [t, x, y, z (km), vx, vy, vz] from liftoff to the parking orbit, the payload's origin (its base on the stack)."""
    ts = np.arange(0.0, T_ORBIT + 1e-9, step)
    pk = [p[0] for p in PROFILE]
    alt = np.array([_interp(pk, [p[1] for p in PROFILE], t) for t in ts])
    spd = np.array([_interp(pk, [p[2] for p in PROFILE], t) for t in ts])
    vz = np.gradient(alt * 1000.0, ts)
    vh = np.sqrt(np.maximum(spd**2 - vz**2, 0.0))
    arc = np.concatenate(
        [
            [0.0],
            np.cumsum(
                0.5
                * (vh[1:] + vh[:-1])
                * np.diff(ts)
                / (R_EARTH * 1000.0 + 0.5 * (alt[1:] + alt[:-1]) * 1000.0)
            ),
        ]
    )
    la0, lo0, b = math.radians(PAD[0]), math.radians(PAD[1]), math.radians(AZIMUTH_DEG)
    pts = []
    for a, ar in zip(alt, arc):
        la = math.asin(
            math.sin(la0) * math.cos(ar) + math.cos(la0) * math.sin(ar) * math.cos(b)
        )
        lo = lo0 + math.atan2(
            math.sin(b) * math.sin(ar) * math.cos(la0),
            math.cos(ar) - math.sin(la0) * math.sin(la),
        )
        pts.append(
            geodetic_to_ecef(math.degrees(la), math.degrees(lo), a + STACK_H / 1000.0)
        )
    p = np.array(pts)
    v = np.gradient(p, ts, axis=0)
    return np.hstack([ts[:, None], p, v])


def _ecef_to_inertial(t_launch_jd, t, p, v):
    """Earth-fixed state to the ecliptic J2000 Earth-centred one."""
    R = ecef_to_ecl(t_launch_jd + t / 86400.0)
    w = np.array([0.0, 0.0, OMEGA_EARTH])
    return R @ p, R @ (v + np.cross(w, p))


def _coast(r0, v0, t0, ts):
    """A near-circular orbit from the state at t0 to the times ts: the position turned about the orbit's normal at its mean motion."""
    h = np.cross(r0, v0)
    n_hat = h / np.linalg.norm(h)
    a = 1.0 / (2.0 / np.linalg.norm(r0) - float(np.dot(v0, v0)) / MU_EARTH)
    n = math.sqrt(MU_EARTH / a**3)
    rows = []
    for t in ts:
        th = n * (t - t0)
        c, s = math.cos(th), math.sin(th)
        r = r0 * c + np.cross(n_hat, r0) * s
        v = v0 * c + np.cross(n_hat, v0) * s
        rows.append(np.concatenate([[t], r, v]))
    return np.array(rows)


def _hermite(a, b, step):
    """Cubic Hermite rows between two states [t, r, v]."""
    from scipy.interpolate import CubicHermiteSpline

    spl = CubicHermiteSpline(
        [a[0], b[0]], np.array([a[1:4], b[1:4]]), np.array([a[4:7], b[4:7]])
    )
    ts = np.arange(a[0], b[0] + 1e-9, step)
    p = spl(ts)
    v = spl.derivative()(ts)
    return np.hstack([ts[:, None], p, v])


def earth_rows():
    """Horizons' Earth-centred table (ecliptic J2000) 12:52 to 14:52 UT on the launch day as [t from launch, x, y, z, vx, vy, vz]."""
    rows = horizons("-168", "2020-07-30 12:52", "2020-07-30 14:52", "10m")
    return np.array([[(r[0] - jd_unix(LAUNCH)) * 86400.0] + list(r[1:7]) for r in rows])


def sun_rows():
    """Horizons' Sun-centred table of the spacecraft, one a day from 14:52 to the approach's start on 2021-02-18 15:00, in AU and AU/s."""
    rows = horizons(
        "-168", "2020-07-30 14:52", "2021-02-18 15:00", "1d", center="500@10"
    )
    out = []
    for r in rows:
        out.append([(r[0] - jd_unix(LAUNCH)) * 86400.0] + [x / AU_KM for x in r[1:7]])
    return np.array(out)


def moon_table():
    """The Moon for the first day, [t from launch, x, y, z, vx, vy, vz] Earth-centred (the player moves anything near the Moon by the difference to the drawn one)."""
    rows = horizons("301", "2020-07-30 11:00", "2020-07-31 12:00", "1h")
    return np.array([[(r[0] - jd_unix(LAUNCH)) * 86400.0] + list(r[1:7]) for r in rows])


def _rows_min_radius(rows):
    return float(np.min(np.linalg.norm(rows[:, 1:4], axis=1)))


def parking_to_injection(lrows, erows):
    """The inertial rows from the parking orbit (at T_ORBIT) to Horizons' first state: a coast, and a Hermite arc for the injection that starts when it gives the shortest path
    that never dips under 6500 km from the Earth's centre. Returns rows and the burn's start.
    """
    jd0 = jd_unix(LAUNCH)
    r0, v0 = _ecef_to_inertial(jd0, lrows[-1, 0], lrows[-1, 1:4], lrows[-1, 4:7])
    best = None
    for tb in np.arange(2000.0, 3200.0, 40.0):
        coast = _coast(r0, v0, lrows[-1, 0], np.arange(lrows[-1, 0], tb + 1e-9, 30.0))
        arc = _hermite(coast[-1], erows[0], 20.0)
        rows = np.vstack([coast[:-1], arc])
        if _rows_min_radius(rows) < 6500.0:
            continue
        length = float(np.sum(np.linalg.norm(np.diff(rows[:, 1:4], axis=0), axis=1)))
        if best is None or length < best[0]:
            best = (length, tb, rows)
    if best is None:
        raise RuntimeError("no injection arc keeps its altitude")
    return best[2], best[1]


def build():
    """Returns the pieces the Mars build joins: the launch leg, the inertial leg to Horizons' last Earth-centred state, the Sun-centred rows, the Moon's table,
    the burn's start, and the events' times."""
    lrows = launch_rows()
    erows = earth_rows()
    inert, tb = parking_to_injection(lrows, erows)
    full_inertial = np.vstack([inert, erows[1:]])
    srows = sun_rows()
    mtab = moon_table()
    print(
        "launch: injection burn from T+%.0f s, %d launch rows, %d inertial rows, %d Sun-centred rows"
        % (tb, len(lrows), len(full_inertial), len(srows))
    )
    launch_leg = {
        "frame": "ecef",
        "ref": "earth",
        "s": pack(thin(lrows, 0.003, 10.0), 4, 6),
    }
    inert_leg = {
        "frame": "eci",
        "ref": "earth",
        "s": pack(thin(full_inertial, 0.5, 600.0), 2, 6),
        "sd": 900,
    }
    helio_leg = {"frame": "helio", "ref": "sun", "s": pack(srows, 8, 12), "sd": 3600}
    return launch_leg, inert_leg, helio_leg, mtab, tb, srows
