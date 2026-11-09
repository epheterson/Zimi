"""Apollo 11 from lunar orbit home: the service module's burn that sent it back (TEI), the last midcourse correction, and the state at the entry
interface the report gives (MR table 7-VII: 400,000 ft, 3.19 S 171.96 E, 36,194.4 ft/s, flight path -6.48 degrees, at 195:03:05.7).
"""

import json
import math
import os

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_moon import sel
from mission_apollo11_orbit import vel_frame
from mission_apollo11_path import SPS_MDOT, SPS_THRUST, ephemerides, geodetic_of
from mission_flight import Burn, Flight
from mission_physics import CACHE, R_EARTH, earth_pole_ecl, ecef_to_ecl, OMEGA_EARTH

TEI_S = 151.4  # ignition 135:23:42.3, cut-off 135:26:13.7
TEI_MASS_KG = 36965.7 * 0.45359237
EI = dict(
    lat=-3.19, lon=171.96, alt_km=121.92, speed_kms=36194.4 * 0.0003048, fpa=-6.48
)
CSM_SEP_DV = 0.82e-3  # km/s, the report's 2.7 ft/s, radial


def to_entry(fl, y_tei, x, dv5, verbose=False):
    """The state at the entry interface time for TEI parameters x (thrust scale, pitch, yaw) and the last correction dv5 (km/s: prograde, radial,
    normal)."""
    b = Burn(
        EVENTS["tei"],
        EVENTS["tei"] + TEI_S,
        SPS_THRUST * x[0],
        SPS_MDOT,
        sign=1,
        pitch=(x[1], x[1]),
        yaw=(x[2], x[2]),
    )
    t, Y = fl.run(y_tei, EVENTS["tei"], EVENTS["tei"] + TEI_S, (b,), step=None)
    y = Y[-1]
    t, Y = fl.run(y, EVENTS["tei"] + TEI_S, EVENTS["mcc5"], (), step=None, rtol=1e-10)
    y = Y[-1].copy()
    p, rad, nrm = vel_frame(y[0:3], y[3:6])
    y[3:6] = y[3:6] + dv5[0] * p + dv5[1] * rad + dv5[2] * nrm
    t, Y = fl.run(y, EVENTS["mcc5"], EVENTS["entry"], (), step=None, rtol=1e-10)
    return Y[-1], b, y


def entry_numbers(fl, y):
    t = EVENTS["entry"]
    lat, lon, alt = geodetic_of(t, y[0:3])
    r, v = y[0:3], y[3:6]
    jd = ZERO_JD + t / 86400
    spin = OMEGA_EARTH * earth_pole_ecl(jd)
    vi = np.linalg.norm(v)
    fpa = math.degrees(math.asin(np.dot(v, r) / (vi * np.linalg.norm(r))))
    return lat, lon, alt, vi, fpa


def guess(fl, y_tei):
    """A first TEI for the optimiser: the two-body Lambert transfer (about the Earth) from where the burn is half done to the entry interface
    point, as a burn direction relative to the motion and a thrust scale."""
    from mission_lambert import lambert
    from mission_physics import MU_EARTH, ecef_to_ecl, geodetic_to_ecef

    t_mid = EVENTS["tei"] + TEI_S / 2
    y_mid = fl.run(y_tei, EVENTS["tei"], t_mid, (), step=None)[1][-1]
    r2 = ecef_to_ecl(ZERO_JD + EVENTS["entry"] / 86400) @ geodetic_to_ecef(EI["lat"], EI["lon"], EI["alt_km"])
    best = None
    for pro in (True, False):
        v1, _ = lambert(y_mid[0:3], r2, EVENTS["entry"] - t_mid, MU_EARTH, prograde=pro, normal=np.cross(y_mid[0:3], y_mid[3:6]))
        dv = v1 - y_mid[3:6]
        if best is None or np.linalg.norm(dv) < np.linalg.norm(best):
            best = dv
    p, rad, nrm = vel_frame(y_mid[0:3], y_mid[3:6])
    pitch = math.atan2(np.dot(best, rad), np.dot(best, p))
    yaw = math.asin(np.dot(best, nrm) / np.linalg.norm(best))
    full = SPS_THRUST * TEI_S / TEI_MASS_KG / 1000.0 * 0.8  # km/s from the burn at roughly average mass, a tenth less for steering losses
    return [np.linalg.norm(best) / full, pitch, yaw]


def fit_return(fl, y_tei, verbose=True):
    def resid(u):
        y, _, _ = to_entry(fl, y_tei, u[0:3], u[3:6] * 1e-3)
        lat, lon, alt, speed, fpa = entry_numbers(fl, y)
        return [
            (lat - EI["lat"]) / 0.15,
            (lon - EI["lon"]) / 0.15,
            (alt - EI["alt_km"]) / 3.0,
            (speed - EI["speed_kms"]) / 0.005,
            (fpa - EI["fpa"]) / 0.1,
            np.linalg.norm(u[3:6]) * 0.05,
        ]

    s = least_squares(
        resid,
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        diff_step=1e-4,
        x_scale=[0.02, 0.02, 0.02, 1.0, 1.0, 1.0],
        max_nfev=40,
    )
    y, b, y_m = to_entry(fl, y_tei, s.x[0:3], s.x[3:6] * 1e-3)
    if verbose:
        print(
            "TEI x%.3f pitch %.3f yaw %.3f; MCC-5 dv (m/s) %s"
            % (s.x[0], s.x[1], s.x[2], np.round(s.x[3:6], 2))
        )
        print(
            "entry interface lat %.2f lon %.2f alt %.1f speed %.3f fpa %.2f  (report %.2f %.2f %.1f %.3f %.2f)"
            % (
                *entry_numbers(fl, y),
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
    x, y, b = fit_return(fl, np.array(d["y_tei"]))
    with open(os.path.join(CACHE, "apollo11_return.json"), "w") as fh:
        json.dump(dict(x=[float(v) for v in x], y_entry=y.tolist()), fh)
