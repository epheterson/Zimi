"""Apollo 11's entry: the command module from the entry interface to the sea. The module (5,486 kg, 3.9 m across the heat shield, lift to drag
0.34 on its trim) flies the report's entry interface state through the air (US Standard Atmosphere 1976) under a roll program fitted
so the drogue parachutes open at 195:12:06.9 at the place the report gives (13.30 N, 169.15 W); then the parachutes, down at 195:18:35.
"""

import json
import math
import os

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS, ZERO_JD
from mission_atmo import fall
from mission_apollo11_path import geodetic_of
from mission_physics import CACHE

CM_MASS = 12095.5 * 0.45359237  # MR table B-I
CM_CD, CM_LD, CM_AREA = 1.29, 0.34, 11.95
DROGUE = dict(
    t=195 * 3600 + 12 * 60 + 6.9, lat=13.30, lon=-169.15, alt_km=7.3
)  # MR table 7-VII (drogue 24,000 ft)
MAIN_ALT_KM = 3.0
SPLASH_T = EVENTS["splash"]


def fly(y_entry, p):
    """p = [roll switch time (s after entry), roll after it (rad), drag scale]. Lift-up until the switch."""
    ts, phi, scale = p
    bank = lambda t: 0.0 if t - EVENTS["entry"] < ts else phi
    return fall(
        np.array(y_entry[0:6]),
        EVENTS["entry"],
        DROGUE["t"] + 400.0,
        ZERO_JD,
        CM_MASS,
        CM_CD * scale,
        CM_AREA,
        lift=(CM_LD, bank),
        step=1.0,
    )


def until_drogue(t, Y):
    """The index at which the module reaches the drogue altitude."""
    for i in range(len(t)):
        if geodetic_of(t[i], Y[i, 0:3])[2] <= DROGUE["alt_km"]:
            return i
    return len(t) - 1


def fit(y_entry, verbose=True):
    def resid(p):
        t, Y = fly(y_entry, p)
        i = until_drogue(t, Y)
        lat, lon, alt = geodetic_of(t[i], Y[i, 0:3])
        return [
            (lat - DROGUE["lat"]) / 0.05,
            (lon - DROGUE["lon"]) / 0.05,
            (t[i] - DROGUE["t"]) / 3.0,
        ]

    s = least_squares(
        resid,
        [250.0, 2.0, 1.0],
        bounds=([20.0, -3.2, 0.7], [600.0, 3.2, 1.3]),
        diff_step=1e-3,
        x_scale=[20.0, 0.2, 0.05],
        max_nfev=60,
    )
    if verbose:
        print(
            "entry: roll switch at +%.0f s to %.2f rad, drag x%.3f; resid %s"
            % (s.x[0], s.x[1], s.x[2], np.round(s.fun, 2))
        )
    return s.x


if __name__ == "__main__":
    d = json.load(open(os.path.join(CACHE, "apollo11_return.json")))
    x = fit(d["y_entry"])
    t, Y = fly(d["y_entry"], x)
    peak = 0.0
    for i in range(1, len(t)):
        a = (
            np.linalg.norm(Y[i, 3:6] - Y[i - 1, 3:6])
            / (t[i] - t[i - 1])
            * 1000
            / 9.80665
        )
        peak = max(peak, a)
    print("peak deceleration about %.1f g (report 6.5 g)" % peak)
    with open(os.path.join(CACHE, "apollo11_entry.json"), "w") as fh:
        json.dump(dict(x=[float(v) for v in x]), fh)
