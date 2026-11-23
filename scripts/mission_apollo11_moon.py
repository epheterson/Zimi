"""Apollo 11 at the Moon: the first midcourse correction, lunar orbit insertion and circularisation, the descent orbit, the
landing and the climb back (see mission_apollo11.py for the sources)."""

import math

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_path import NMI, SPS_ISP, SPS_MDOT, SPS_THRUST, closest_moon
from mission_flight import Burn
from mission_physics import MU_MOON, R_MOON, ecl_to_eq, moon_rotation, xyz_to_lunar

TDB_MINUS_UT_S = 40.2  # 1969 (IERS)


def jd_tdb(t):
    return ZERO_JD + (t + TDB_MINUS_UT_S) / 86400


def fixed_matrix(t):
    """Ecliptic J2000 -> Moon-fixed at mission time t."""
    return moon_rotation(jd_tdb(t)) @ ecl_to_eq()


def sel(fl, t, y):
    """Selenocentric position and velocity (inertial, ecliptic J2000) of a geocentric state."""
    pm, vm = fl.moon.state(t)
    return y[0:3] - pm, y[3:6] - vm


def lunar_latlon(fl, t, y):
    r, _ = sel(fl, t, y)
    return xyz_to_lunar(fixed_matrix(t) @ r)


def moon_elements(fl, t, y):
    """Apolune and perilune altitude (km), inclination to the lunar equator (deg) of the orbit about the Moon."""
    r, v = sel(fl, t, y)
    rn, vn = np.linalg.norm(r), np.linalg.norm(v)
    h = np.cross(r, v)
    ev = np.cross(v, h) / MU_MOON - r / rn
    e = np.linalg.norm(ev)
    a = 1 / (2 / rn - vn * vn / MU_MOON)
    pole = fixed_matrix(t).T @ np.array([0.0, 0.0, 1.0])
    inc = math.degrees(math.acos(np.dot(h, pole) / np.linalg.norm(h)))
    return dict(
        a=a,
        e=e,
        ra=a * (1 + e) - R_MOON,
        rp=a * (1 - e) - R_MOON,
        inc=inc,
        period=2 * math.pi * math.sqrt(abs(a) ** 3 / MU_MOON),
    )
