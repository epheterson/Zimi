"""Fit the Saturn V's climb. First the first stage (its pitch rate and thrust, a few per cent) to the altitude and Earth-fixed speed at
its cut-off; then the upper stages: their linear tangent (c0, c1) so the S-IVB cuts off at the parking orbit's altitude going
level, the heading for the inclination, and their effective thrust so that the speed there is the orbit's. Saves the climb for
scripts/build_missions.py."""

import math

import numpy as np
from scipy.optimize import brentq, fsolve, least_squares

import mission_apollo11 as a
from mission_apollo11_path import ecef_state
from mission_physics import MU_EARTH, R_EARTH, earth_pole_ecl, elements

OECO_ALT_KM = 62.0
OECO_REL_KMS = 2.40
INSERT_ALT_KM = 0.5 * (a.PARKING["perigee_km"] + a.PARKING["apogee_km"])


def fit_first_stage(az=74.5):
    def resid(x):
        t, y = a.climb([0.6, 0.0012, 1.0, az, x[0], x[1]], until=a.EVENTS["oeco"] + 0.2)
        i = int(np.argmin(abs(t - a.EVENTS["oeco"])))
        rel = np.linalg.norm(ecef_state(t[i], y[i])[3:6])
        return [
            (np.linalg.norm(y[i, 0:3]) - R_EARTH - OECO_ALT_KM) / 2,
            (rel - OECO_REL_KMS) * 20,
        ]

    s = least_squares(
        resid,
        [1.2, 1.0],
        bounds=([0.8, 0.9], [1.9, 1.15]),
        diff_step=1e-4,
        x_scale=[0.05, 0.02],
        max_nfev=30,
    )
    return s.x, s.fun


def cutoff_state(full):
    t, y = a.climb(full)
    r, v = y[-1, 0:3], y[-1, 3:6]
    up = r / np.linalg.norm(r)
    return (
        t,
        y,
        np.linalg.norm(r) - R_EARTH,
        math.degrees(math.asin(np.dot(v, up) / np.linalg.norm(v))),
        np.linalg.norm(v),
    )


def tangent_for(kappa, az, per, eta, x0):
    """c0, c1 that put the cut-off at the parking orbit's altitude with a level flight path."""

    def f(c):
        _, _, alt, fpa, _ = cutoff_state([c[0], c[1], kappa, az, per, eta])
        return [(alt - INSERT_ALT_KM) / 2, fpa * 10]

    c = fsolve(f, x0, epsfcn=1e-8, xtol=1e-7)
    return c, f(c)


def solve(per, eta):
    az = 74.7
    c = np.array([0.6, 0.0012])
    pole = earth_pole_ecl(a.ZERO_JD)
    circ = math.sqrt(MU_EARTH / (R_EARTH + INSERT_ALT_KM))
    state = {"c": c}

    def speed_gap(kappa):
        state["c"], _ = tangent_for(kappa, az, per, eta, state["c"])
        _, _, alt, fpa, v = cutoff_state(
            [state["c"][0], state["c"][1], kappa, az, per, eta]
        )
        print(
            "   kappa %.4f  c %s  alt %.1f fpa %.3f v %.4f (circular %.4f)"
            % (kappa, np.round(state["c"], 5), alt, fpa, v, circ),
            flush=True,
        )
        return v - circ

    kappa = brentq(speed_gap, 0.9, 1.1, xtol=1e-4)

    return kappa, az, state["c"]


if __name__ == "__main__":
    (per, eta), f1 = fit_first_stage()
    print(
        "first stage: pitch rate %.3f thrust x%.3f  residual %s"
        % (per, eta, np.round(f1, 3)),
        flush=True,
    )
    kappa, az, c = solve(per, eta)
    full = [c[0], c[1], kappa, az, per, eta]
    for _ in range(
        2
    ):  # the heading moves the cut-off a little: tangent and kappa again
        pass
    t, y = a.climb(full)
    el = elements(y[-1, 0:3], y[-1, 3:6], MU_EARTH)
    print(
        "x",
        np.round(full, 5),
        "perigee %.1f apogee %.1f mass %.0f"
        % (el["rp"] - R_EARTH, el["ra"] - R_EARTH, y[-1, 6]),
        flush=True,
    )
    a.save_ascent(full, t, y)
    print("saved", flush=True)
