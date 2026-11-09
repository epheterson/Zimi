"""Apollo 11's powered descent in the Moon's own turning frame: the braking burn at the descent engine's fixed throttle, flown to the
altitude and descent rate of high gate (MR section 5: 7,129 ft and 125 ft/s at 102:41:32, P64), then the explicit guidance of the final
approach (to P66 at 102:43:22, about 600 ft) and the landing at 102:45:39.9 on Tranquility Base (0.67408 N, 23.473 E).
"""

import math

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS
from mission_apollo11_moon import fixed_matrix
from mission_landing import descend
from mission_physics import MU_MOON, R_MOON, lunar_to_xyz

G0 = 9.80665
SITE = (0.67408, 23.473)  # the landmark the 3D view draws (LROC)
OMEGA_MOON = 2 * math.pi / (27.321661 * 86400.0)
DPS_FTP = 43.9e3  # fixed throttle position, N (92.5 per cent of 47.5 kN)
DPS_MIN = 4.7e3  # minimum throttle (10 per cent)
DPS_MAX = 45.0e3
DPS_ISP = 304.0
PDI_MIN_S = (
    26.0  # minimum throttle for this long after ignition, to settle the propellant
)
HG_T = EVENTS["pdi"] + (
    41 * 60 + 32 - 33 * 60 - 5
)  # 102:41:32 -> seconds from range zero
LG_T = EVENTS["pdi"] + (43 * 60 + 22 - 33 * 60 - 5)  # 102:43:22: P66
HG_ALT_M = 7129 * 0.3048
HG_VZ = -125 * 0.3048
LG_ALT_M = 600 * 0.3048
THROTTLE_DOWN_S = 386.0  # MR: throttle reduction at 386 s after ignition
PDI_MASS_KG = (
    33401.6 * 0.45359237 - 20.0
)  # MR table B-I, DOI cut-off, less the reaction control used since


def to_fixed(fl, t, y):
    """A geocentric inertial state as Moon-fixed position (m) and velocity relative to the turning Moon (m/s)."""
    pm, vm = fl.moon.state(t)
    F = fixed_matrix(t)
    r = F @ (y[0:3] - pm) * 1000.0
    v = F @ (y[3:6] - vm) * 1000.0 - np.cross([0.0, 0.0, OMEGA_MOON], r)
    return r, v


def spin():
    return np.array([0.0, 0.0, OMEGA_MOON])


def site_xyz():
    return lunar_to_xyz(SITE[0], SITE[1], 0.0) * 1000.0


def brake(r0, v0, m0, x, T):
    """The braking phase for T seconds at fixed throttle: thrust against the motion, tilted up by an angle that runs linearly from x[0] to
    x[1] (radians), the throttle x[2] of FTP. Returns the rows [t, r, v, m] each second and the thrust.
    """
    w = spin()

    def f(t, y):
        r, v, m = y[0:3], y[3:6], y[6]
        up = r / np.linalg.norm(r)
        hv = v - np.dot(v, up) * up
        hh = hv / (np.linalg.norm(hv) + 1e-9)
        ang = x[0] + (x[1] - x[0]) * t / T
        d = -math.cos(ang) * hh + math.sin(ang) * up
        thr = (
            DPS_MIN
            if t < PDI_MIN_S
            else (DPS_FTP * x[2] if t < THROTTLE_DOWN_S else DPS_FTP * x[2] * x[3])
        )
        g = -MU_MOON * 1e9 * r / np.linalg.norm(r) ** 3
        a = g - 2 * np.cross(w, v) - np.cross(w, np.cross(w, r)) + d * thr / m
        return np.concatenate([v, a, [-thr / (DPS_ISP * G0)]])

    grid = np.arange(0, T + 1e-9, 1.0)
    sol = solve_ivp(
        f,
        (0, T),
        np.concatenate([r0, v0, [m0]]),
        method="DOP853",
        rtol=1e-9,
        atol=1e-6,
        t_eval=grid,
    )
    return sol.t, sol.y.T


def ground_range_to_site(r):
    s = site_xyz()
    c = np.dot(r, s) / (np.linalg.norm(r) * np.linalg.norm(s))
    return math.acos(max(-1, min(1, c))) * R_MOON * 1000.0


def fit_braking(r0, v0, m0, verbose=True):
    T = HG_T - EVENTS["pdi"]

    def resid(x):
        t, y = brake(r0, v0, m0, x, T)
        r, v = y[-1, 0:3], y[-1, 3:6]
        up = r / np.linalg.norm(r)
        return [
            (np.linalg.norm(r) - R_MOON * 1000 - HG_ALT_M) / 40.0,
            (np.dot(v, up) - HG_VZ) / 2.0,
            (ground_range_to_site(r) - 7400.0) / 150.0,
            (x[3] - 0.7) * 0.3,
        ]

    s = least_squares(
        resid,
        [0.15, 0.25, 0.95, 0.7],
        bounds=([-0.6, -0.6, 0.6, 0.3], [1.2, 1.4, 1.0, 1.0]),
        diff_step=1e-3,
        x_scale=[0.05, 0.05, 0.02, 0.05],
        max_nfev=60,
    )
    if verbose:
        print(
            "braking: tilt %.3f -> %.3f rad, throttle x%.3f, later x%.3f; resid %s"
            % (s.x[0], s.x[1], s.x[2], s.x[3], np.round(s.fun, 3))
        )
    return s.x


def final_approach(y_hg, m_hg, t_hg, verbose=True):
    """The explicit guidance from high gate to the surface: to 600 ft at P66, then down to the site."""
    r, v = y_hg[0:3], y_hg[3:6]
    site = site_xyz()
    up = site / np.linalg.norm(site)
    hv = site - r
    hdir = hv - np.dot(hv, up) * up
    hdir /= np.linalg.norm(hdir)
    tgt = lambda back, alt: site + up * alt - hdir * back
    segs = [
        dict(
            t1=LG_T - EVENTS["pdi"],
            rf=tgt(600.0, LG_ALT_M),
            vf=hdir * 13.0 - up * 4.5,
            af=-hdir * 0.15 + up * 0.0,
        ),
        dict(
            t1=EVENTS["landing"] - EVENTS["pdi"],
            rf=tgt(0.0, 0.0),
            vf=-up * 0.6,
            af=np.zeros(3),
        ),
    ]
    t, y = descend(
        np.concatenate([r, v, [m_hg]]),
        t_hg - EVENTS["pdi"],
        segs,
        MU_MOON,
        spin(),
        (DPS_MIN, DPS_MAX),
        DPS_ISP,
    )
    return t, y, segs


def descent(fl, y_pdi, verbose=True):
    """Everything from powered descent initiation to touchdown: rows [t(mission s), x, y, z, vx, vy, vz (m, m/s in the Moon-fixed frame), mass]."""
    r0, v0 = to_fixed(fl, EVENTS["pdi"], y_pdi)
    x = fit_braking(r0, v0, PDI_MASS_KG, verbose)
    T = HG_T - EVENTS["pdi"]
    tb, yb = brake(r0, v0, PDI_MASS_KG, x, T)
    t2, y2, segs = final_approach(yb[-1, 0:6], yb[-1, 6], T, verbose)
    t_all = np.concatenate([tb[:-1], t2]) + EVENTS["pdi"]
    y_all = np.vstack([yb[:-1], y2])
    end = y_all[-1]
    if verbose:
        site = site_xyz()
        print(
            "touchdown: %.1f m from the site, vertical %.2f m/s, horizontal %.2f m/s, mass %.0f kg (report 7,327)"
            % (
                np.linalg.norm(end[0:3] - site),
                end[3:6] @ (site / np.linalg.norm(site)),
                np.linalg.norm(end[3:6]),
                end[6],
            )
        )
    return t_all, y_all, x
