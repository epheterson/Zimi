"""Apollo 11: from translunar injection to the instant before powered descent. The first midcourse correction is solved for the
pericynthion the report gives, lunar orbit insertion and circularisation for the orbits it gives, the descent orbit for the
altitude and place of powered descent initiation. Every step prints what it reached against the report.
"""

import math

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS
from mission_apollo11_moon import fixed_matrix, lunar_latlon, moon_elements, sel
from mission_apollo11_path import (
    NMI,
    SPS_ISP,
    SPS_MDOT,
    SPS_THRUST,
    approach_inclination,
    build_translunar,
    closest_moon,
)
from mission_flight import Burn, burn_mdot
from mission_physics import R_MOON

INCLINATION = 178.7  # the lunar orbits ran west, 1.3 degrees off the equator
LOI1_S = 357.6  # MR table 7-II: ignition 75:49:50.4, cut-off 75:55:48.0
LOI2_S = 16.7
PERILUNE_TARGET = dict(ra=169.7 * NMI, rp=60.0 * NMI)  # after LOI-1 (MR section 7)
CIRCULAR_TARGET = dict(ra=65.7 * NMI, rp=53.8 * NMI)  # after LOI-2
MCC2_PERI_KM = 61.5 * NMI
DOI_S = 29.8
LM_DPS_THRUST_DOI = 10.9e3
LM_DPS_ISP = 304.0
LM_MASS_DOI = 33669.6 * 0.45359237  # MR table B-I, kg
PDI_ALT_KM = 49376 * 0.0003048  # MR table 5-III best-estimate state


def vel_frame(r, v):
    p = v / np.linalg.norm(v)
    h = np.cross(r, v)
    h /= np.linalg.norm(h)
    return p, np.cross(h, p), h  # prograde, radial-outward, normal


def mcc2(fl, y0, t0, aim_t):
    """The correction that gives the pericynthion altitude and time of the report; returns the state after it."""

    def after(dv):
        p, rad, nrm = vel_frame(y0[0:3], y0[3:6])
        y = y0.copy()
        y[3:6] = y[3:6] + dv[0] * p + dv[1] * rad + dv[2] * nrm
        return y

    def resid(dv):
        tp, dp, yp = closest_moon(fl, t0, after(dv), aim_t + 4 * 3600, step=600.0)
        return [(dp - R_MOON - MCC2_PERI_KM) / 3.0, (tp - aim_t) / 20.0, (approach_inclination(fl, tp, yp) - INCLINATION) / 2.0]

    s = least_squares(
        resid,
        [0.0, 0.0, 0.0],
        diff_step=1e-3,
        x_scale=[0.005, 0.005, 0.005],
        max_nfev=30,
    )
    return after(s.x), s.x, resid(s.x)


def burn_fit(fl, y0, t0, dur, sign, targets, x0=(1.0, 0.0, 0.0)):
    """A service-propulsion burn (thrust scaled by x[0]; pitch x[1] to x[2] across it) solved so the orbit about the Moon it leaves
    has the apolune and perilune altitudes of `targets`."""
    mass = y0[6]

    def burn(x):
        return Burn(
            t0, t0 + dur, SPS_THRUST * x[0], SPS_MDOT, sign=sign, pitch=(x[1], x[2]), rel=fl.moon
        )

    def end(x):
        t, y = fl.run(y0, t0, t0 + dur, (burn(x),), step=None)
        return y[-1]

    def resid(x):
        e = moon_elements(fl, t0 + dur, end(x))
        return [
            (e["ra"] - targets["ra"]) / 2.0,
            (e["rp"] - targets["rp"]) / 2.0,
            x[1] * 12.0 + x[2] * 12.0,
        ]

    s = least_squares(
        resid, x0, diff_step=1e-4, x_scale=[0.01, 0.02, 0.02], max_nfev=30
    )
    return burn(s.x), s.x, resid(s.x), end(s.x)


LOI1_CUT = dict(lat=0.16, lon=167.13)  # MR table 7-II: lunar orbit insertion cut-off, 60.1 nautical miles up


def mcc_and_loi1(fl, y_mcc, t_mcc, verbose=True):
    """The midcourse correction (three components) and the thrust of lunar orbit insertion, solved together so the burn,
    flown straight against the motion for the 357.6 s the report gives, ends where and in the orbit the report says."""
    t1 = EVENTS["loi1"]

    def flown(u):
        p, rad, nrm = vel_frame(y_mcc[0:3], y_mcc[3:6])
        y = y_mcc.copy()
        y[3:6] = y[3:6] + u[0] * p + u[1] * rad + u[2] * nrm
        t, Y = fl.run(y, t_mcc, t1, (), step=None)
        y_l = Y[-1].copy()
        y_l[6] = 96061.6 * 0.45359237  # the spacecraft's mass at ignition, MR table B-I
        burn = Burn(t1, t1 + LOI1_S, SPS_THRUST * u[3], SPS_MDOT, sign=-1, pitch=(u[4], u[4]), yaw=(u[5], u[5]), rel=fl.moon)
        tb, Yb = fl.run(y_l, t1, t1 + LOI1_S, (burn,), step=None)
        return y, y_l, burn, Yb[-1]

    def resid(u):
        y, y_l, burn, y_c = flown(u)
        e = moon_elements(fl, t1 + LOI1_S, y_c)
        lat, lon, alt = lunar_latlon(fl, t1 + LOI1_S, y_c)
        return [(e["ra"] - PERILUNE_TARGET["ra"]) / 2.0, (e["rp"] - PERILUNE_TARGET["rp"]) / 2.0, (lat - LOI1_CUT["lat"]) / 0.3,
                (lon - LOI1_CUT["lon"]) / 0.3, (alt - 111.3) / 1.0, np.linalg.norm(u[0:3]) * 40.0, u[4] * 4.0, (e["inc"] - INCLINATION) / 0.4, u[5] * 6.0]

    s = least_squares(resid, [-0.007, -0.003, 0.0, 1.0, 0.0, 0.0], diff_step=1e-3, x_scale=[0.003, 0.003, 0.003, 0.02, 0.02, 0.02], max_nfev=120)
    y, y_l, burn, y_c = flown(s.x)
    e = moon_elements(fl, t1 + LOI1_S, y_c)
    lat, lon, alt = lunar_latlon(fl, t1 + LOI1_S, y_c)
    if verbose:
        print("MCC-2 dv (pro, rad, nrm) m/s", np.round(s.x[0:3] * 1000, 2), "|dv| %.2f m/s (report 6.5)" % (np.linalg.norm(s.x[0:3]) * 1000))
        print("LOI-1 pitch %.3f rad, thrust x%.3f -> orbit %.1f x %.1f km (report %.1f x %.1f), incl %.2f; cut-off lat %.2f lon %.2f alt %.1f (report %.2f, %.2f, 111.3)" % (
            s.x[4], s.x[3], e["ra"], e["rp"], PERILUNE_TARGET["ra"], PERILUNE_TARGET["rp"], e["inc"], lat, lon, alt, LOI1_CUT["lat"], LOI1_CUT["lon"]))
        print("   at ignition", np.round(lunar_latlon(fl, t1, y_l), 2), "(report 1.57 S, 190.4 E, 160.6 km)")
    return y, s.x[0:3], y_l, burn, s.x, y_c, resid(s.x)


SEP_AT = 100 * 3600 + 39 * 60 + 52.9  # the command module's separation manoeuvre
CSM_SEP_DV = 0.82e-3  # km/s, the report's 2.7 ft/s, radial
TEI_LON_E = 169.2  # the report has 164.02 E at 135:23:42.3; the return fit starts its burn 104 s earlier, 5.2 degrees east on this orbit, so the orbit is trimmed to be there at the report time


def csm_to_tei(fl, y0, t0):
    ta, Ya = fl.run(y0, t0, SEP_AT, (), step=None)
    y = Ya[-1].copy()
    p, rad, nrm = vel_frame(y[0:3], y[3:6])
    y[3:6] = y[3:6] + CSM_SEP_DV * rad
    tb, Yb = fl.run(y, SEP_AT, EVENTS["tei"], (), step=None)
    return Yb[-1]


def trim_phase(fl, y_cut2, verbose=True):
    """The orbit's period is the one thing a point-mass Moon cannot give right over two days (the Moon's lumpy gravity moved Columbia by
    2.5 nautical miles in the report's predictions): a tangential trim at the end of circularisation, a metre a second or so, puts the
    command module where the report has it at trans-Earth injection (164.02 E)."""
    from scipy.optimize import brentq

    t0 = EVENTS["loi2"] + LOI2_S

    def gap(dv):
        y = y_cut2.copy()
        p, rad, nrm = vel_frame(y[0:3], y[3:6])
        y[3:6] = y[3:6] + dv * p
        lon = lunar_latlon(fl, EVENTS["tei"], csm_to_tei(fl, y, t0))[1]
        return (lon - TEI_LON_E + 180.0) % 360.0 - 180.0

    dv = brentq(gap, -0.003, 0.003, xtol=1e-7)
    y = y_cut2.copy()
    p, rad, nrm = vel_frame(y[0:3], y[3:6])
    y[3:6] = y[3:6] + dv * p
    if verbose:
        print("phase trim %.2f m/s at the end of LOI-2 -> command module at %.2f E at TEI" % (dv * 1000, lunar_latlon(fl, EVENTS["tei"], csm_to_tei(fl, y, t0))[1]))
    return y, dv


def run(verbose=True):
    res = build_translunar(verbose=verbose)
    fl = res["fl"]
    out = dict(res=res)
    t_inj = EVENTS["tli"]
    # to the first midcourse correction
    t, Y = fl.run(res["y_inj"], t_inj, EVENTS["mcc2"], (), step=60.0)
    y_mcc = Y[-1]
    y_after, dv, y_loi, b1, x1, y_cut1, f1 = mcc_and_loi1(fl, y_mcc, EVENTS["mcc2"], verbose)
    e1 = moon_elements(fl, EVENTS["loi1"] + LOI1_S, y_cut1)
    out.update(y_mcc=y_mcc, y_mcc_after=y_after, mcc_dv=dv)
    out.update(y_loi=y_loi, loi1=b1, y_cut1=y_cut1, e1=e1)
    # two revolutions later, circularisation
    t3, Y3 = fl.run(y_cut1, EVENTS["loi1"] + LOI1_S, EVENTS["loi2"], (), step=30.0)
    y_loi2 = Y3[-1]
    y_loi2[6] = 72019.9 * 0.45359237
    b2, x2, f2, y_cut2 = burn_fit(
        fl, y_loi2, EVENTS["loi2"], LOI2_S, -1, CIRCULAR_TARGET, x0=(1.0, 0.0, 0.0)
    )
    e2 = moon_elements(fl, EVENTS["loi2"] + LOI2_S, y_cut2)
    if verbose:
        print(
            "LOI-2 x",
            np.round(x2, 4),
            "orbit %.1f x %.1f km (report %.1f x %.1f), incl %.2f, resid %s"
            % (
                e2["ra"],
                e2["rp"],
                CIRCULAR_TARGET["ra"],
                CIRCULAR_TARGET["rp"],
                e2["inc"],
                np.round(f2, 3),
            ),
        )
    y_cut2, trim_dv = trim_phase(fl, y_cut2, verbose)
    out.update(y_loi2=y_loi2, loi2=b2, y_cut2=y_cut2, e2=e2, trim_dv=trim_dv)
    return out


if __name__ == "__main__":
    run()
