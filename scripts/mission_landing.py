"""Powered flight to and from a body's surface in its own turning frame: a guided descent (the Apollo LM's explicit guidance: a
quadratic in time for the commanded acceleration, solved to reach a position, velocity and acceleration after a time) and a
pitched ascent. Used for the Moon here; scripts/build_missions.py reuses it for the landers of other missions. Units km,
km/s, s. States are in the body-fixed frame: x through the prime meridian on the equator, z the pole.
"""

import math

import numpy as np
from scipy.integrate import solve_ivp

G0 = 9.80665


def solve_poly_guidance(r, v, rf, vf, af, T):
    """c0, c1, c2 of a(t) = c0 + c1 t + c2 t^2 taking (r, v) to (rf, vf, af) in T, per axis (m, m/s, m/s^2)."""
    A = np.array(
        [[T, T**2 / 2, T**3 / 3], [T**2 / 2, T**3 / 6, T**4 / 12], [1.0, T, T**2]]
    )
    out = np.zeros((3, 3))
    for k in range(3):
        b = np.array([vf[k] - v[k], rf[k] - r[k] - v[k] * T, af[k]])
        out[k] = np.linalg.solve(A, b)
    return out  # [axis][c0, c1, c2]


def gravity_m(r_m, mu_km3):
    r = np.linalg.norm(r_m)
    return -mu_km3 * 1e9 * r_m / r**3


def descend(
    y0_fixed,
    t0,
    segments,
    mu_km3,
    omega,
    thrust_range_n,
    isp,
    lander_dry_kg=0.0,
    step=1.0,
    rtol=1e-9,
):
    """Closed-loop guided descent. y0_fixed: [x, y, z (m), vx, vy, vz (m/s), mass (kg)] in the body-fixed frame.
    `segments`: dicts with t1 (mission seconds the segment ends) and rf, vf, af (the targets in the body-fixed frame, m).
    omega: the body's spin vector (rad/s, fixed frame). Returns times and rows (metres, m/s, kg).
    """
    w = np.asarray(omega)
    ts, ys, thrusts = [], [], []
    y = np.array(y0_fixed, dtype=float)
    t = t0
    tmin, tmax = thrust_range_n
    for seg in segments:
        T_end = seg["t1"]
        rf, vf, af = (np.asarray(seg[k], float) for k in ("rf", "vf", "af"))

        def f(tt, yy):
            r, v, m = yy[0:3], yy[3:6], yy[6]
            tgo = max(T_end - tt, 1.0)
            c = solve_poly_guidance(r, v, rf, vf, af, tgo)
            a_cmd = c[:, 0]
            fict = -2 * np.cross(w, v) - np.cross(w, np.cross(w, r))
            a_thr = a_cmd - gravity_m(r, mu_km3) - fict
            mag = np.linalg.norm(a_thr) * m
            mag = min(max(mag, tmin), tmax)
            d = a_thr / (np.linalg.norm(a_thr) + 1e-12)
            a = gravity_m(r, mu_km3) + fict + d * mag / m
            return np.concatenate([v, a, [-mag / (isp * G0)]])

        grid = np.unique(
            np.concatenate(
                [[t], np.arange(math.ceil(t / step) * step, T_end, step), [T_end]]
            )
        )
        sol = solve_ivp(
            f, (t, T_end), y, method="DOP853", rtol=rtol, atol=1e-6, t_eval=grid
        )
        ts.append(sol.t[:-1])
        ys.append(sol.y.T[:-1])
        y = sol.y[:, -1]
        t = T_end
    ts.append(np.array([t]))
    ys.append(y[None, :])
    return np.concatenate(ts), np.vstack(ys)
