"""Apollo 11's flight as one chain through its source document (scripts/missions/apollo11.json), on the missions' one fitter
(mission_fit.py): every coast lands on the report's next state, every burn is the engine's own burn solved toward the report's
cut-off. The launch, the powered descent, the lunar ascent and rendezvous, and the entry stay in their own modules; this file
hands each its start state and takes back its end.

    python3 scripts/mission_apollo11_chain.py     # each link's gap to the report, the burns' solutions

Returns per vehicle the rows the player draws: [t, x, y, z, vx, vy, vz, m] (km, km/s, kg; Earth-centred ecliptic J2000).
"""

import json
import os

import numpy as np

import mission_apollo11_descent as desc
from mission_apollo11 import EVENTS, ZERO_JD
from mission_apollo11_lm import LM_MASS_UNDOCK
from mission_apollo11_orbit import DOI_S, LM_DPS_ISP, LM_DPS_THRUST_DOI
from mission_apollo11_path import (
    SPS_MDOT,
    SPS_THRUST,
    TLI_MDOT,
    TLI_THRUST,
    ephemerides,
)
from mission_apollo11_return import TEI_MASS_KG
from mission_fit import coast_to, fit_burn, fit_impulse, gap, report_state
from mission_flight import Flight, burn_mdot
from mission_physics import earth_pole_ecl

SOURCE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "missions", "apollo11.json"
)
LB = 0.45359237
# Masses at the burns (MR table B-I, pounds), the S-IVB's at its restart from the Saturn V flight evaluation (rounded)
MASS = dict(
    tli=136000.0,
    loi1=96061.6 * LB,
    loi2=72019.9 * LB,
    tei=TEI_MASS_KG,
    lm=LM_MASS_UNDOCK,
    csm=36965.7 * LB,
)


def load_source():
    with open(SOURCE) as fh:
        return json.load(fh)


def anchors(src, moon):
    return {
        e["key"]: report_state(e, ZERO_JD, moon)
        for e in src["events"]
        if "v" in e and "fpa" in e
    }


def _with_mass(y, m):
    return np.concatenate([y[0:6], [m]])


def _rows(t, Y):
    return np.hstack([np.asarray(t)[:, None], np.asarray(Y)])


def run(verbose=True, y_park_start=None, t_park_start=None):
    """The chain. y_park_start/t_park_start: the launch's end (the parking orbit's first state), when the launch is part of it."""
    src = load_source()
    moon, sun = ephemerides()
    fl = Flight(moon, sun, earth_pole_ecl(ZERO_JD))
    A = anchors(src, moon)
    T = {e["key"]: e["t"] for e in src["events"]}
    log = []

    def note(what, y, key):
        km, ms = gap(y, A[key])
        log.append((what, key, km, ms))
        if verbose:
            print("%-28s -> %-9s gap %9.2f km %8.2f m/s" % (what, key, km, ms))

    out = dict(fl=fl, moon=moon, anchors=A, times=T, log=log)
    # ── The stack: the parking orbit lands on the TLI ignition state; the S-IVB's burn toward the cut-off ──
    if y_park_start is not None:
        note(
            "parking orbit (forward)",
            fl.run(y_park_start, t_park_start, T["tli_ign"], (), step=None)[1][-1],
            "tli_ign",
        )
        tp, Yp = coast_to(
            fl,
            _with_mass(y_park_start, MASS["tli"]),
            t_park_start,
            T["tli_ign"],
            A["tli_ign"],
            step=10.0,
        )
        out["park"] = _rows(tp, Yp)
    y_ign = _with_mass(A["tli_ign"], MASS["tli"])
    b_tli, x_tli, y_cut, f = fit_burn(
        fl, y_ign, T["tli_ign"], T["tli_cut"], TLI_THRUST, TLI_MDOT, 1, A["tli_cut"]
    )
    note("TLI burn x=%s" % np.round(x_tli, 3), y_cut, "tli_cut")
    out.update(y_ign=y_ign, tli_burn=b_tli, tli_x=x_tli, y_tli_cut=y_cut)
    # ── To the Moon: the coast lands on the report's state at the midcourse correction; the correction aims at lunar orbit insertion ──
    t1, Y1 = coast_to(fl, y_cut, T["tli_cut"], T["mcc2_ign"], A["mcc2_ign"], step=60.0)
    y_mcc = _with_mass(A["mcc2_ign"], MASS["loi1"])
    dv, y_after, f = fit_impulse(
        fl, y_mcc, T["mcc2_ign"], T["loi1_ign"], A["loi1_ign"], components=3
    )
    if verbose:
        print(
            "MCC-2 dv (pro, rad, nrm) m/s %s |dv| %.2f (report 6.4)"
            % (np.round(dv * 1000, 2), np.linalg.norm(dv) * 1000)
        )
    t2, Y2 = coast_to(
        fl, y_after, T["mcc2_ign"], T["loi1_ign"], A["loi1_ign"], step=60.0
    )
    note(
        "coast after MCC-2",
        fl.run(y_after, T["mcc2_ign"], T["loi1_ign"], (), step=None)[1][-1],
        "loi1_ign",
    )
    out.update(
        translunar=_rows(t1, Y1),
        mcc_dv=dv,
        y_mcc=y_mcc,
        y_mcc_after=y_after,
        to_moon=_rows(t2, Y2),
    )
    # ── Lunar orbit insertion and circularisation ──
    y = _with_mass(A["loi1_ign"], MASS["loi1"])
    b1, x1, y1, f = fit_burn(
        fl,
        y,
        T["loi1_ign"],
        T["loi1_cut"],
        SPS_THRUST,
        SPS_MDOT,
        -1,
        A["loi1_cut"],
        rel=moon,
    )
    note("LOI-1 burn x=%s" % np.round(x1, 3), y1, "loi1_cut")
    t3, Y3 = coast_to(
        fl,
        _with_mass(y1, MASS["loi2"]),
        T["loi1_cut"],
        T["loi2_ign"],
        A["loi2_ign"],
        step=30.0,
    )
    y = _with_mass(A["loi2_ign"], MASS["loi2"])
    b2, x2, y2, f = fit_burn(
        fl,
        y,
        T["loi2_ign"],
        T["loi2_cut"],
        SPS_THRUST,
        SPS_MDOT,
        -1,
        A["loi2_cut"],
        rel=moon,
    )
    note("LOI-2 burn x=%s" % np.round(x2, 3), y2, "loi2_cut")
    t4, Y4 = coast_to(fl, y2, T["loi2_cut"], T["undock"], A["undock"], step=30.0)
    note(
        "orbit to undocking",
        fl.run(y2, T["loi2_cut"], T["undock"], (), step=None)[1][-1],
        "undock",
    )
    out.update(
        loi1=b1,
        y_loi1_ign=_with_mass(A["loi1_ign"], MASS["loi1"]),
        y_loi1_cut=y1,
        lunar1=_rows(t3, Y3),
        loi2=b2,
        y_loi2_ign=_with_mass(A["loi2_ign"], MASS["loi2"]),
        y_loi2_cut=y2,
        lunar2=_rows(t4, Y4),
    )
    # ── Eagle: the descent orbit, then powered descent from the report's state at its start ──
    y = _with_mass(A["undock"], MASS["lm"])
    t5, Y5 = coast_to(fl, y, T["undock"], T["doi_ign"], A["doi_ign"], step=20.0)
    note(
        "Eagle to DOI",
        fl.run(y, T["undock"], T["doi_ign"], (), step=None)[1][-1],
        "doi_ign",
    )
    thr = LM_DPS_THRUST_DOI
    b3, x3, y3, f = fit_burn(
        fl,
        _with_mass(A["doi_ign"], MASS["lm"]),
        T["doi_ign"],
        T["doi_cut"],
        thr,
        burn_mdot(thr, LM_DPS_ISP),
        -1,
        A["doi_cut"],
        rel=moon,
    )
    note("DOI burn x=%s" % np.round(x3, 3), y3, "doi_cut")
    t6, Y6 = coast_to(fl, y3, T["doi_cut"], T["pdi"], A["pdi"], step=10.0)
    note(
        "descent orbit to PDI",
        fl.run(y3, T["doi_cut"], T["pdi"], (), step=None)[1][-1],
        "pdi",
    )
    y_pdi = _with_mass(A["pdi"], y3[6])
    t_d, y_d, xb = desc.descent(fl, y_pdi, verbose=verbose)
    out.update(
        eagle_orbit=_rows(t5, Y5),
        doi=b3,
        y_doi_ign=_with_mass(A["doi_ign"], MASS["lm"]),
        descent_orbit=_rows(t6, Y6),
        y_pdi=y_pdi,
        descent=(t_d, y_d),
    )
    # ── Columbia alone: the separation manoeuvre, its orbit to the docking and to trans-Earth injection ──
    y = _with_mass(A["undock"], MASS["csm"])
    t7, Y7 = coast_to(fl, y, T["undock"], T["sep_ign"], A["sep_ign"], step=30.0)
    t8, Y8 = coast_to(
        fl,
        _with_mass(A["sep_cut"], MASS["csm"]),
        T["sep_cut"],
        T["dock2"],
        A["dock2"],
        step=30.0,
    )
    note(
        "Columbia to docking",
        fl.run(
            _with_mass(A["sep_cut"], MASS["csm"]),
            T["sep_cut"],
            T["dock2"],
            (),
            step=None,
        )[1][-1],
        "dock2",
    )
    t9, Y9 = coast_to(
        fl,
        _with_mass(A["dock2"], MASS["tei"]),
        T["dock2"],
        T["tei_ign"],
        A["tei_ign"],
        step=30.0,
    )
    note(
        "Columbia to TEI",
        fl.run(
            _with_mass(A["dock2"], MASS["tei"]), T["dock2"], T["tei_ign"], (), step=None
        )[1][-1],
        "tei_ign",
    )
    b4, x4, y4, f = fit_burn(
        fl,
        _with_mass(A["tei_ign"], MASS["tei"]),
        T["tei_ign"],
        T["tei_cut"],
        SPS_THRUST,
        SPS_MDOT,
        1,
        A["tei_cut"],
        rel=moon,
    )
    note("TEI burn x=%s" % np.round(x4, 3), y4, "tei_cut")
    t10, Y10 = coast_to(
        fl, y4, T["tei_cut"], T["cm_sm_sep"], A["cm_sm_sep"], step=300.0
    )
    note(
        "coast home",
        fl.run(y4, T["tei_cut"], T["cm_sm_sep"], (), step=None)[1][-1],
        "cm_sm_sep",
    )
    t11, Y11 = coast_to(
        fl,
        _with_mass(A["cm_sm_sep"], 5557.0),
        T["cm_sm_sep"],
        T["entry"],
        A["entry"],
        step=10.0,
    )
    note(
        "command module to entry",
        fl.run(
            _with_mass(A["cm_sm_sep"], 5557.0),
            T["cm_sm_sep"],
            T["entry"],
            (),
            step=None,
        )[1][-1],
        "entry",
    )
    out.update(
        columbia_sep=_rows(t7, Y7),
        columbia_orbit=_rows(t8, Y8),
        columbia_to_tei=_rows(t9, Y9),
        tei=b4,
        y_tei_ign=_with_mass(A["tei_ign"], MASS["tei"]),
        y_tei_cut=y4,
        home=_rows(t10, Y10),
        to_entry=_rows(t11, Y11),
    )
    return out


if __name__ == "__main__":
    run(verbose=True)
