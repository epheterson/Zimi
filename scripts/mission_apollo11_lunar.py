"""Columbia alone in lunar orbit: from the circularisation burn through the separation manoeuvre to the instant of trans-Earth injection."""

import json
import os

import numpy as np

import mission_physics as mp
from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_moon import lunar_latlon, moon_elements
from mission_apollo11_orbit import vel_frame
from mission_apollo11_path import ephemerides
from mission_apollo11_return import CSM_SEP_DV, TEI_MASS_KG
from mission_flight import Flight

SEP_AT = 100 * 3600 + 39 * 60 + 52.9  # the CSM's three-impulse separation, 100:39:52.9


def csm_orbit(fl, y_cut2, step=30.0):
    """Rows of Columbia from the end of LOI-2 to TEI ignition, with the separation manoeuvre."""
    t0 = EVENTS["loi2"] + 16.7
    ta, Ya = fl.run(y_cut2, t0, SEP_AT, (), step=step)
    y = Ya[-1].copy()
    p, rad, nrm = vel_frame(y[0:3], y[3:6])
    y[3:6] = y[3:6] + CSM_SEP_DV * rad
    tb, Yb = fl.run(y, SEP_AT, EVENTS["tei"], (), step=step)
    return np.concatenate([ta, tb[1:]]), np.vstack([Ya, Yb[1:]])


if __name__ == "__main__":
    moon, sun = ephemerides()
    fl = Flight(moon, sun, mp.earth_pole_ecl(ZERO_JD))
    d = json.load(open(os.path.join(mp.CACHE, "apollo11_stage3.json")))
    t, Y = csm_orbit(fl, np.array(d["y_cut2"]))
    y_tei = Y[-1].copy()
    y_tei[6] = TEI_MASS_KG
    e = moon_elements(fl, EVENTS["tei"], y_tei)
    print(
        "Columbia at TEI: orbit %.1f x %.1f km, lat/lon/alt" % (e["ra"], e["rp"]),
        np.round(lunar_latlon(fl, EVENTS["tei"], y_tei), 2),
        "(report -0.16 S, 164.0 E, 52.4 nmi = 97 km)",
    )
    with open(os.path.join(mp.CACHE, "apollo11_lunar.json"), "w") as fh:
        json.dump(dict(y_tei=y_tei.tolist()), fh)
