"""Apollo 11's lunar module: undocking, the descent orbit and the powered descent to Tranquility Base (MR tables 5-I, 5-III, 7-II and
B-I give the times, the state at powered descent initiation and the masses), then the climb back and the rendezvous.
"""

import math

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS
from mission_apollo11_moon import fixed_matrix, lunar_latlon, sel
from mission_apollo11_orbit import (
    LM_DPS_ISP,
    LM_DPS_THRUST_DOI,
    LM_MASS_DOI,
    PDI_ALT_KM,
    DOI_S,
    vel_frame,
)
from mission_flight import Burn, burn_mdot
from mission_physics import R_MOON

LM_MASS_UNDOCK = 33683.5 * 0.45359237
UNDOCK_DV = 0.31  # m/s, the springs and a thrust, retrograde (the report: 'separation' then a three-impulse CSM manoeuvre)
CSM_SEP_DV = 0.82  # m/s, 2.7 ft/s radial (MR 7)
PDI_LAT, PDI_LON = 1.037, 39.371  # MR table 5-III, best-estimate state


def lm_to_pdi(fl, y_csm_undock, kappa=1.0):
    """The lunar module from undocking to powered descent initiation; returns (rows, state at PDI)."""
    y = y_csm_undock.copy()
    p, rad, nrm = vel_frame(y[0:3], y[3:6])
    y[3:6] = y[3:6] - UNDOCK_DV / 1000.0 * p
    y[6] = LM_MASS_UNDOCK
    t_u = EVENTS["undock"]
    t_d = EVENTS["doi"]
    ta, Ya = fl.run(y, t_u, t_d, (), step=20.0)
    thrust = LM_DPS_THRUST_DOI * kappa
    b = Burn(t_d, t_d + DOI_S, thrust, burn_mdot(thrust, LM_DPS_ISP), sign=-1)
    tb, Yb = fl.run(Ya[-1], t_d, t_d + DOI_S, (b,), step=2.0)
    tc, Yc = fl.run(Yb[-1], t_d + DOI_S, EVENTS["pdi"], (), step=10.0)
    return (np.concatenate([ta, tb[1:], tc[1:]]), np.vstack([Ya, Yb[1:], Yc[1:]])), Yc[
        -1
    ]


def fit_doi(fl, y_csm_undock, verbose=True):
    """Scale the descent engine's thrust in the descent orbit insertion burn so powered descent begins at the report's altitude."""

    def alt_at_pdi(x):
        _, y = lm_to_pdi(fl, y_csm_undock, x[0])
        return lunar_latlon(fl, EVENTS["pdi"], y)[2]

    def resid(x):
        return [(alt_at_pdi(x) - PDI_ALT_KM) / 0.3]

    s = least_squares(resid, [1.0], diff_step=1e-3, x_scale=[0.2], max_nfev=15)
    rows, y = lm_to_pdi(fl, y_csm_undock, s.x[0])
    lat, lon, alt = lunar_latlon(fl, EVENTS["pdi"], y)
    if verbose:
        print(
            "DOI thrust x%.3f -> at PDI lat %.2f lon %.2f alt %.2f km (report %.2f N %.2f E %.2f km)"
            % (s.x[0], lat, lon, alt, PDI_LAT, PDI_LON, PDI_ALT_KM)
        )
    return s.x[0], rows, y
