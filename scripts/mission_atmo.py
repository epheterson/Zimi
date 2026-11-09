"""Atmosphere and the fall through it: spent stages and entry capsules. The Earth's air is the US Standard Atmosphere 1976 (densities
at the altitudes below, log-interpolated); Mars's is an exponential fitted to the Mars-GRAM scale height.
"""

import math

import numpy as np
from scipy.integrate import solve_ivp

from mission_physics import (
    J2_EARTH,
    MU_EARTH,
    OMEGA_EARTH,
    R_EARTH,
    earth_pole_ecl,
    ecef_to_ecl,
    unit,
)

# altitude km, density kg/m^3 (US Standard Atmosphere 1976)
US1976 = [
    (0, 1.225),
    (5, 0.7364),
    (10, 0.4135),
    (15, 0.1948),
    (20, 0.08891),
    (25, 0.04008),
    (30, 0.01841),
    (40, 0.003996),
    (50, 1.027e-3),
    (60, 3.097e-4),
    (70, 8.283e-5),
    (80, 1.846e-5),
    (90, 3.416e-6),
    (100, 5.604e-7),
    (110, 9.708e-8),
    (120, 2.222e-8),
    (150, 2.076e-9),
    (200, 2.541e-10),
    (300, 1.916e-11),
]
_ALT = np.array([a for a, _ in US1976])
_LOGRHO = np.log([r for _, r in US1976])


def rho_earth(alt_km):
    if alt_km >= _ALT[-1]:
        return math.exp(_LOGRHO[-1] - (alt_km - _ALT[-1]) / 45.0)
    return math.exp(float(np.interp(max(alt_km, 0.0), _ALT, _LOGRHO)))


def fall(y0, t0, t1, jd_zero, mass, cd, area_m2, lift=None, step=1.0):
    """A body falling through the Earth's air from the inertial state y0 = [r, v] (km, km/s, ecliptic J2000) until it is at the
    sea or t1. `lift`: optional (cl_over_cd, bank_fn(t) radians) for a capsule: the lift is perpendicular to the relative
    velocity, banked about it. Returns times and rows [r, v]."""
    jd0 = jd_zero + t0 / 86400
    pole = earth_pole_ecl(jd0)
    spin = OMEGA_EARTH * pole
    k_j2 = 1.5 * J2_EARTH * MU_EARTH * R_EARTH**2

    def f(t, y):
        r, v = y[0:3], y[3:6]
        rn = np.linalg.norm(r)
        alt = rn - R_EARTH
        vrel = v - np.cross(spin, r)
        sp = np.linalg.norm(vrel) + 1e-12
        z = np.dot(r, pole) / rn
        a = -MU_EARTH * r / rn**3 + k_j2 / rn**5 * (
            r * (5 * z * z - 1) - 2 * rn * z * pole
        )
        q = 0.5 * rho_earth(alt) * (sp * 1000) ** 2
        a = a - q * cd * area_m2 / mass * vrel / sp / 1000.0
        if lift:
            ld, bank = lift
            up = unit(r)
            side = unit(np.cross(vrel, up))
            perp = unit(
                np.cross(side, vrel)
            )  # up, perpendicular to the relative velocity
            b = bank(t)
            a = (
                a
                + q
                * cd
                * ld
                * area_m2
                / mass
                * (math.cos(b) * perp + math.sin(b) * side)
                / 1000.0
            )
        return np.concatenate([v, a])

    def sea(t, y):
        return np.linalg.norm(y[0:3]) - R_EARTH

    sea.terminal = True
    sea.direction = -1
    grid = np.arange(math.ceil(t0 / step) * step, t1, step)
    sol = solve_ivp(
        f, (t0, t1), y0, method="DOP853", rtol=1e-9, atol=1e-9, t_eval=grid, events=sea
    )
    return sol.t, sol.y.T
