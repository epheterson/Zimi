"""Apollo 11 from lunar orbit home: the service module's burn that sent it back (TEI), the last midcourse correction, and the state at the entry
interface the report gives (MR table 7-VII: 400,000 ft, 3.19 S 171.96 E, 36,194.4 ft/s, flight path -6.48 degrees, at 195:03:05.7).

A point-mass Moon puts Columbia a few degrees from where the real, lumpy one was after two days, and the burn that brings it home is fixed by
where in the orbit it starts. The burn therefore starts when this orbit is in the right place (the fit's `dt`, within the half hour before the
report's time and after it) rather than exactly at 135:23:42.3."""

import json
import math
import os

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_orbit import vel_frame
from mission_apollo11_path import SPS_MDOT, SPS_THRUST, ephemerides, geodetic_of
from mission_flight import Burn, Flight
from mission_physics import CACHE, earth_pole_ecl

TEI_S = 151.4  # ignition 135:23:42.3, cut-off 135:26:13.7
TEI_MASS_KG = 36965.7 * 0.45359237
TEI_BASE_S = (
    1800.0  # the fit may start the burn from this long before the report's time
)
EI = dict(
    lat=-3.19, lon=171.96, alt_km=121.92, speed_kms=36194.4 * 0.0003048, fpa=-6.48
)
CSM_SEP_DV = 0.82e-3  # km/s, the report's 2.7 ft/s, radial


def tei_start(p):
    """The ignition time for the fit's dt (p[3])."""
    return EVENTS["tei"] - TEI_BASE_S + p[3]


def to_entry(fl, y_base, p, dv5):
    """The state at the entry interface time. y_base: Columbia TEI_BASE_S before the report's TEI. p = [thrust scale, pitch, yaw, dt]; dv5 (km/s: prograde,
    radial, normal) is the last midcourse correction."""
    t_base = EVENTS["tei"] - TEI_BASE_S
    t0 = tei_start(p)
    ya = y_base if p[3] < 1.0 else fl.run(y_base, t_base, t0, (), step=None)[1][-1]
    b = Burn(
        t0,
        t0 + TEI_S,
        SPS_THRUST * p[0],
        SPS_MDOT,
        sign=1,
        pitch=(p[1], p[1]),
        yaw=(p[2], p[2]),
        rel=fl.moon,
    )
    y = fl.run(ya, t0, t0 + TEI_S, (b,), step=None)[1][-1]
    y = fl.run(y, t0 + TEI_S, EVENTS["mcc5"], (), step=None, rtol=1e-10)[1][-1].copy()
    pf, rad, nrm = vel_frame(y[0:3], y[3:6])
    y[3:6] = y[3:6] + dv5[0] * pf + dv5[1] * rad + dv5[2] * nrm
    return (
        fl.run(y, EVENTS["mcc5"], EVENTS["entry"], (), step=None, rtol=1e-10)[1][-1],
        b,
        y,
    )


def entry_numbers(y):
    lat, lon, alt = geodetic_of(EVENTS["entry"], y[0:3])
    r, v = y[0:3], y[3:6]
    vi = np.linalg.norm(v)
    return (
        lat,
        lon,
        alt,
        vi,
        math.degrees(math.asin(np.dot(v, r) / (vi * np.linalg.norm(r)))),
    )


def fit_return(fl, y_base, verbose=True):
    def resid(u):
        y, _, _ = to_entry(fl, y_base, u[0:4], u[4:7] * 1e-3)
        lat, lon, alt, speed, fpa = entry_numbers(y)
        return [
            (lat - EI["lat"]) / 0.15,
            (lon - EI["lon"]) / 0.15,
            (alt - EI["alt_km"]) / 3.0,
            (speed - EI["speed_kms"]) / 0.005,
            (fpa - EI["fpa"]) / 0.1,
            np.linalg.norm(u[4:7]) * 0.05,
            u[2] * 0.2,
        ]

    best = None
    for dt0 in (
        600.0,
        1500.0,
        2400.0,
        3300.0,
    ):  # the burn's place in the orbit: a few starts, the landscape is wavy
        s = least_squares(
            resid,
            [1.0, 0.0, 0.0, dt0, 0.0, 0.0, 0.0],
            diff_step=1e-4,
            x_scale=[0.02, 0.05, 0.05, 60.0, 1.0, 1.0, 1.0],
            bounds=(
                [0.9, -1.2, -0.6, 0.0, -20, -20, -20],
                [1.2, 1.2, 0.6, TEI_BASE_S * 2, 20, 20, 20],
            ),
            max_nfev=25,
        )
        if verbose:
            print(
                "   start dt %.0f -> cost %.3g  dt %.0f" % (dt0, s.cost, s.x[3]),
                flush=True,
            )
        if best is None or s.cost < best.cost:
            best = s
        if s.cost < 5:
            break
    s = best
    y, b, y_m = to_entry(fl, y_base, s.x[0:4], s.x[4:7] * 1e-3)
    if verbose:
        print(
            "TEI at %.0f s from the report's time: x%.3f pitch %.3f yaw %.3f; MCC-5 dv (m/s) %s"
            % (s.x[3] - TEI_BASE_S, s.x[0], s.x[1], s.x[2], np.round(s.x[4:7], 2))
        )
        print(
            "entry interface lat %.2f lon %.2f alt %.1f speed %.3f fpa %.2f  (report %.2f %.2f %.1f %.3f %.2f)"
            % (
                *entry_numbers(y),
                EI["lat"],
                EI["lon"],
                EI["alt_km"],
                EI["speed_kms"],
                EI["fpa"],
            )
        )
    return s.x, y, b


if __name__ == "__main__":
    moon, sun = ephemerides()
    fl = Flight(moon, sun, earth_pole_ecl(ZERO_JD))
    d = json.load(open(os.path.join(CACHE, "apollo11_lunar.json")))
    x, y, b = fit_return(fl, np.array(d["y_base"]))
    with open(os.path.join(CACHE, "apollo11_return.json"), "w") as fh:
        json.dump(dict(x=[float(v) for v in x], y_entry=y.tolist()), fh)
