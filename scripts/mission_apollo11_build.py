"""Apollo 11 as the mission player's data: every vehicle's legs, the phases and the events. Runs the whole reconstruction (the stages are fitted
to the mission report, see mission_apollo11.py and its siblings) and writes the tables; build_missions.py calls it.
"""

import json
import math
import os

import numpy as np

import mission_apollo11 as a11
import mission_apollo11_ascent as asc
import mission_apollo11_descent as desc
import mission_apollo11_entry as ent
import mission_apollo11_lm as lm
import mission_apollo11_lunar as lunar
import mission_apollo11_orbit as orbit
import mission_apollo11_path as path
import mission_apollo11_return as ret
import mission_physics as mp
from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_moon import fixed_matrix
from mission_atmo import fall
from mission_flight import Burn, Flight
from mission_tables import pack, thin

E = EVENTS
T_START = -15.0
GET = lambda h, m, s=0.0: h * 3600 + m * 60 + s

# The stack's parts (metres along its axis from the first stage's base; the models are in craft-ms-*-v1.bin). Total height with the escape
# tower 110.6 m (Saturn V Flight Manual).
STACK = {
    "sic": ("ms-sic", 0.0),
    "sii": ("ms-sii", 40.6),
    "sivb": ("ms-sivb", 67.6),
    "sla": ("ms-sla", 86.3),
    "sm": ("ms-sm", 94.8),
    "cm": ("ms-cm", 102.3),
    "let": ("ms-let", 102.3),
}


def part(key, **kw):
    m, y = STACK[key]
    d = {"m": m, "at": [0.0, y, 0.0]}
    d.update(kw)
    return d


def rows_of(t, Y, cols=6):
    return np.hstack([np.asarray(t)[:, None], np.asarray(Y)[:, 0:cols]])


def eci_leg(rows, tol, ref="earth", att=None, max_gap=None):
    leg = {"frame": "eci", "ref": ref, "s": pack(thin(rows, tol, max_gap), 4, 7)}
    if att:
        leg["att"] = att
    return leg


def ecef_rows(t, Y):
    return np.array(
        [np.concatenate([[ti], path.ecef_state(ti, yi)]) for ti, yi in zip(t, Y)]
    )


def moon_rows(fl, t, Y):
    """Geocentric rows to Moon-fixed (km, km/s relative to the turning Moon) rows."""
    out = []
    for ti, yi in zip(t, Y):
        pm, vm = fl.moon.state(ti)
        F = fixed_matrix(ti)
        r = F @ (yi[0:3] - pm)
        v = F @ (yi[3:6] - vm) - np.cross([0.0, 0.0, desc.OMEGA_MOON], r)
        out.append(np.concatenate([[ti], r, v]))
    return np.array(out)


def build():
    out = orbit.run(verbose=False)
    res = out["res"]
    fl = res["fl"]
    t_asc, y_asc = path.load_ascent()
    vehicles, events = [], []

    # ── The climb: the stack in Earth-fixed rows, its spent stages falling on their own ──
    asc_rows = ecef_rows(t_asc, y_asc)
    hold = np.concatenate([[T_START], asc_rows[0, 1:4], [0, 0, 0]])
    asc_leg = {
        "frame": "ecef",
        "ref": "earth",
        "s": pack(thin(np.vstack([hold, asc_rows]), 0.01, 20.0), 4, 6),
    }
    return dict(out=out, fl=fl, asc_leg=asc_leg)
