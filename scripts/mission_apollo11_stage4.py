"""Apollo 11's powered descent, from the state at powered descent initiation that mission_apollo11_stage3.py saved."""

import faulthandler
import json
import os
import sys

import numpy as np

import mission_apollo11_path as path
import mission_physics as mp
from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_descent import descent
from mission_flight import Flight

if __name__ == "__main__":
    faulthandler.dump_traceback_later(240, repeat=True, file=sys.stderr)
    d = json.load(open(os.path.join(mp.CACHE, "apollo11_stage3.json")))
    moon, sun = path.ephemerides()
    fl = Flight(moon, sun, mp.earth_pole_ecl(ZERO_JD))
    t, y, x = descent(fl, np.array(d["y_pdi"]))
    for i in range(0, len(t), 60):
        r = y[i, :3]
        print(
            int(t[i] - EVENTS["pdi"]),
            "alt %.0f" % (np.linalg.norm(r) - mp.R_MOON * 1000),
            "v %.0f" % np.linalg.norm(y[i, 3:6]),
            "m %.0f" % y[i, 6],
        )
