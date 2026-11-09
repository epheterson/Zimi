"""Apollo 11 as the mission player's data: every vehicle's legs, the phases and the events. Runs the reconstruction (each stage fitted to the mission
report, see mission_apollo11.py and its siblings) and returns the mission for build_missions.py to write.
"""

import json
import math
import os

import numpy as np

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
from mission_flight import Burn
from mission_lambert import lambert
from mission_physics import CACHE, MU_MOON
from mission_tables import pack, thin

E = EVENTS
T_START = -15.0


def get(h, m, s=0.0):
    return h * 3600 + m * 60 + s


# Extra events (MR table 3-I, 5-I, 7-II) that are not fitted: they only label the timeline.
EXTRA = dict(
    ceco=135.2,
    sii_ign_cmd=E["sii_ign"],
    hatch=get(109, 7, 33),
    first_step=get(109, 24, 15),
    hatch_closed=get(111, 39, 13),
    csi=get(125, 19, 35),
    cdh=get(126, 17, 49.6),
    tpi=get(127, 3, 51.8),
    dock2=get(128, 3, 0.0),
    jettison=get(130, 9, 31.2),
    p64=get(102, 41, 32),
    p66=get(102, 43, 22),
    alarm1=get(102, 38, 22),
    alarm2=get(102, 39, 2),
    alarm3=get(102, 42, 18),
    alarm4=get(102, 42, 43),
    alarm5=get(102, 42, 58),
    throttle_down=get(102, 33, 5) + 386,
    insertion_moon=get(124, 29, 15.7),
    cm_sm_sep=E["cm_sm_sep"],
    drogue=ent.DROGUE["t"],
)

# The stack's parts (metres along its axis from the first stage's base): Saturn V Flight Manual SA-507.
Y_SII, Y_SIVB, Y_SLA, Y_CSM = 40.6, 67.6, 86.3, 94.8
Y_LM_IN_SLA = 88.6  # the lunar module's feet, inside the adapter
LM_ASC_Z = 3.0  # the ascent stage on the descent stage (the NASA model is 3.37 m tall)


def ecef_rows(t, Y):
    return np.array(
        [np.concatenate([[ti], path.ecef_state(ti, yi)]) for ti, yi in zip(t, Y)]
    )


def eci(rows, tol, ref="earth", att=None, max_gap=None, **kw):
    leg = {"frame": "eci", "ref": ref, "s": pack(thin(rows, tol, max_gap), 4, 7)}
    if att:
        leg["att"] = att
    leg.update(kw)
    return leg


def geo_rows(t, Y):
    return np.hstack([np.asarray(t)[:, None], np.asarray(Y)[:, 0:6]])


def shifted(rows, metres_fn):
    """Rows moved along the direction of travel by metres_fn(t) (the vehicle frame's y axis is the velocity in an inertial leg)."""
    out = rows.copy()
    for i in range(len(out)):
        d = out[i, 4:7] / np.linalg.norm(out[i, 4:7])
        out[i, 1:4] += d * metres_fn(out[i, 0]) / 1000.0
    return out


def moon_fixed_rows(fl, t, Y):
    """Geocentric rows into the Moon-fixed frame (km, km/s relative to the turning Moon)."""
    out = []
    for ti, yi in zip(t, Y):
        pm, vm = fl.moon.state(ti)
        F = fixed_matrix(ti)
        r = F @ (yi[0:3] - pm)
        out.append(
            np.concatenate(
                [[ti], r, F @ (yi[3:6] - vm) - np.cross([0.0, 0.0, desc.OMEGA_MOON], r)]
            )
        )
    return np.array(out)


def part(model, y=0.0, **kw):
    d = {"m": model, "at": [0.0, y, 0.0]}
    d.update(kw)
    return d


def build_launch_to_orbit(fl, vehicles):
    t, y = path.load_ascent()
    asc_rows = ecef_rows(t, y)
    hold = np.concatenate([[T_START], asc_rows[0, 1:4], [0, 0, 0]])
    return t, y, np.vstack([hold, asc_rows])


def fallen(fl, t, y, t0, mass, cd, area, parts, name, span=900.0):
    i = int(np.argmin(abs(t - t0)))
    tt, YY = fall(y[i, 0:6].copy(), t[i], t[i] + span, ZERO_JD, mass, cd, area)
    rows = ecef_rows(tt, YY)
    return {
        "id": name,
        "on": float(t[i]),
        "off": float(tt[-1]),
        "legs": [
            {"frame": "ecef", "ref": "earth", "s": pack(thin(rows, 0.05, 15.0), 4, 6)}
        ],
        "parts": parts,
        "flames": [],
        "dot": False,
    }
