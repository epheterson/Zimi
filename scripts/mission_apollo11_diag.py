import json
import os

import numpy as np

import mission_apollo11_return as ret
import mission_physics as mp
from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_path import ephemerides
from mission_flight import Flight

moon, sun = ephemerides()
fl = Flight(moon, sun, mp.earth_pole_ecl(ZERO_JD))
d = json.load(open(os.path.join(mp.CACHE, "apollo11_lunar.json")))
y_tei = np.array(d["y_tei"])
g = ret.guess(fl, y_tei)
print("guess", g, flush=True)
for kappa in (0.96, 1.0, 1.04, 1.08):
    y, b, ym = ret.to_entry(fl, y_tei, [kappa, g[1], g[2]], [0, 0, 0])
    t, Y = fl.run(
        y_tei, EVENTS["tei"], EVENTS["entry"] + 3 * 3600, (b,), step=300.0, rtol=1e-8
    )
    r = np.linalg.norm(Y[:, 0:3], axis=1)
    i = int(np.argmin(r))
    print(
        kappa,
        "at EI time",
        np.round(ret.entry_numbers(fl, y), 2),
        "closest approach %.0f km at %.0f s after EI time"
        % (r[i] - mp.R_EARTH, t[i] - EVENTS["entry"]),
        flush=True,
    )
