"""Apollo 11's ascent stage: from the Sea of Tranquility into lunar orbit (MR: lift-off 124:22:00.8, engine cut-off 124:29:15.7 in a 9 by 45
nautical mile orbit, 10,776.6 lb falling to 5,928.6 lb) and the rendezvous with Columbia: the coelliptic sequence, the terminal phase, the
docking at 128:03:00."""

import math

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import fsolve, least_squares

from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_descent import OMEGA_MOON, site_xyz
from mission_apollo11_moon import fixed_matrix, moon_elements, sel
from mission_lambert import lambert
from mission_physics import MU_MOON, R_MOON, unit

G0 = 9.80665
APS_THRUST = 15.6e3
APS_ISP = 311.0
LIFTOFF_MASS = 10776.6 * 0.45359237
BURN_S = 434.9  # MR: 124:22:00.8 to 124:29:15.7
INSERTION = dict(ra_km=45 * 1.852, rp_km=9 * 1.852)  # 9 by 45 nautical miles
VERTICAL_RISE_S = 10.0


def liftoff_state(fl):
    """The lander at the site at lift-off, inertial about the Moon (km, km/s)."""
    t = EVENTS["liftoff_moon"]
    F = fixed_matrix(t)
    r_fix = site_xyz() / 1000.0
    v_fix_inertial = np.cross([0.0, 0.0, OMEGA_MOON], r_fix)
    return F.T @ r_fix, F.T @ v_fix_inertial


def climb(fl, plane, x, mass0=LIFTOFF_MASS, t_end=None, step=1.0):
    """The ascent engine's burn, thrust held in the plane of Columbia's orbit: tan(elevation) = c0 - c1 (t - 10 s) after a vertical rise.
    x = [c0, c1]. Returns times and rows [r, v, m] about the Moon (km, km/s, kg), inertial.
    """
    t0 = EVENTS["liftoff_moon"]
    r0, v0 = liftoff_state(fl)
    mdot = APS_THRUST / (APS_ISP * G0)
    t_end = t_end or t0 + BURN_S

    def f(t, y):
        r, v, m = y[0:3], y[3:6], y[6]
        up = r / np.linalg.norm(r)
        tau = t - t0
        if tau < VERTICAL_RISE_S:
            d = up
        else:
            el = math.atan(max(x[0] - x[1] * (tau - VERTICAL_RISE_S), 0.0))
            horiz = unit(unit(np.cross(plane, up)) - 3.0 * np.dot(plane, up) * plane)
            d = math.sin(el) * up + math.cos(el) * horiz
        thr = APS_THRUST if t < t0 + BURN_S else 0.0
        a = -MU_MOON * y[0:3] / np.linalg.norm(y[0:3]) ** 3 + d * thr / m / 1000.0
        return np.concatenate([v, a, [-(mdot if thr else 0.0)]])

    grid = np.arange(t0, t_end + 1e-9, step)
    sol = solve_ivp(
        f,
        (t0, t_end),
        np.concatenate([r0, v0, [mass0]]),
        method="DOP853",
        rtol=1e-10,
        atol=1e-10,
        t_eval=grid,
    )
    return sol.t, sol.y.T


def fit_climb(fl, plane, verbose=True):
    def resid(x):
        t, y = climb(fl, plane, x)
        r, v = y[-1, 0:3], y[-1, 3:6]
        rn, vn = np.linalg.norm(r), np.linalg.norm(v)
        a = 1 / (2 / rn - vn * vn / MU_MOON)
        h = np.cross(r, v)
        ev = np.cross(v, h) / MU_MOON - r / rn
        e = np.linalg.norm(ev)
        return [
            (a * (1 + e) - R_MOON - INSERTION["ra_km"]) / 1.0,
            (a * (1 - e) - R_MOON - INSERTION["rp_km"]) / 1.0,
        ]

    s = least_squares(
        resid, [2.0, 0.004], diff_step=1e-5, x_scale=[0.2, 0.0005], max_nfev=60
    )
    if verbose:
        print(
            "ascent: c0 %.4f c1 %.5f, orbit resid (km) %s"
            % (s.x[0], s.x[1], np.round(s.fun, 3))
        )
    return s.x
