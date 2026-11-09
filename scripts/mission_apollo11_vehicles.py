"""Apollo 11's vehicles, phases and events as the mission player's data (see almanac-missions.js for the format)."""

import json
import math
import os

import numpy as np

import mission_apollo11_build as B
import mission_apollo11_descent as desc
import mission_apollo11_entry as ent
import mission_apollo11_lm as lm
import mission_apollo11_lunar as lunar
import mission_apollo11_orbit as orbit
import mission_apollo11_path as path
import mission_apollo11_return as ret
import mission_physics as mp
from mission_apollo11 import EVENTS as E, ZERO_JD
from mission_apollo11_build import (
    EXTRA,
    T_START,
    eci,
    fallen,
    geo_rows,
    get,
    moon_fixed_rows,
    part,
    shifted,
)
from mission_atmo import fall
from mission_flight import Burn
from mission_physics import CACHE
from mission_tables import pack, thin

CSMLM_OFFSET_M = 102.6  # where the docked pair's lunar module feet were when it was pulled out of the adapter, along the stack's axis
CSM_IN_PAIR_M = 20.3  # and the service module's base above them
CSM_ENGINE_FLAME = dict(at=[0.0, -2.8, 0.0], len=9.0, r=1.1)


def rows_between(fl, y0, t0, t1, step, burns=(), tol=0.05, max_gap=None):
    t, Y = fl.run(y0, t0, t1, burns, step=step)
    return Y[-1].copy(), geo_rows(t, Y)


def assemble(verbose=False):
    out = orbit.run(verbose=verbose)
    res = out["res"]
    fl = res["fl"]
    t_asc, y_asc, asc_rows = B.build_launch_to_orbit(fl, None)
    V = []

    # ── The stack: the climb, the parking orbit, the translunar burn and the coast to ejection from the adapter ──
    legs = [
        {"frame": "ecef", "ref": "earth", "s": pack(thin(asc_rows, 0.01, 20.0), 4, 6)}
    ]
    legs.append(eci(geo_rows(res["t_park"], res["y_park"]), 0.02, max_gap=120.0))
    y, rows = rows_between(
        fl, res["y_ign"], E["tli_ign"], E["tli_cut"], 2.0, (res["tli_burn"],)
    )
    legs.append(eci(rows, 0.02, max_gap=20.0))
    y_cut_tli = y
    y, rows = rows_between(fl, y, E["tli_cut"], E["eject"], 20.0)
    legs.append(eci(rows, 0.05, max_gap=120.0))
    y_eject = y
    lm_anim = [
        {"t": E["csm_siv_sep"], "at": [0, B.Y_LM_IN_SLA, 0], "rx": -90},
        {"t": E["eject"] - 100, "at": [0, B.Y_LM_IN_SLA, 0], "rx": -90},
        {"t": E["eject"], "at": [0, B.Y_LM_IN_SLA + 14.0, 0], "rx": -90},
    ]
    csm_anim = [
        {"t": E["csm_siv_sep"], "at": [0, B.Y_CSM, 0], "rx": 0},
        {"t": E["csm_siv_sep"] + 40, "at": [0, B.Y_CSM + 4.0, 0], "rx": 0},
        {"t": E["csm_siv_sep"] + 130, "at": [7.0, B.Y_CSM + 24.0, 3.0], "rx": 0},
        {"t": E["csm_siv_sep"] + 250, "at": [11.0, B.Y_CSM + 32.0, 3.0], "rx": 100},
        {"t": E["csm_siv_sep"] + 340, "at": [5.0, B.Y_CSM + 24.0, 1.0], "rx": 165},
        {
            "t": E["dock2"] if False else E["dock"],
            "at": [0, B.Y_LM_IN_SLA + 8.0 + 12.4, 0],
            "rx": 180,
        },
        {"t": E["eject"] - 100, "at": [0, B.Y_LM_IN_SLA + 8.0 + 12.4, 0], "rx": 180},
        {"t": E["eject"], "at": [0, B.Y_LM_IN_SLA + 22.0 + 12.4, 0], "rx": 180},
    ]
    lm_parts = [
        part("site-lm", rx=-90, **{"from": E["csm_siv_sep"], "to": E["eject"]}),
        part("ms-lm-asc", rx=-90, **{"from": E["csm_siv_sep"], "to": E["eject"]}),
    ]
    # the lunar module parts ride the keyframes of lm_anim, the ascent stage a little above the descent stage
    lm_parts[0]["anim"] = lm_anim
    lm_parts[1]["anim"] = [
        dict(k, at=[k["at"][0], k["at"][1] + B.LM_ASC_Z, k["at"][2]]) for k in lm_anim
    ]
    V.append(
        {
            "id": "stack",
            "on": T_START,
            "off": E["eject"],
            "legs": legs,
            "parts": [
                part("ms-sic", 0.0, to=E["oeco"]),
                part("ms-sii", B.Y_SII, to=E["sii_cut"]),
                part("ms-sivb", B.Y_SIVB),
                part("ms-sla", B.Y_SLA, to=E["csm_siv_sep"]),
                part("ms-sla-open", B.Y_SLA, **{"from": E["csm_siv_sep"]}),
                part("ms-csm", B.Y_CSM, anim=csm_anim),
                part("ms-let", B.Y_CSM + 7.5 + 2.8, to=E["let"]),
            ]
            + lm_parts,
            "flames": [
                {
                    "from": -6.5,
                    "to": E["oeco"],
                    "at": [0, -3.5, 0],
                    "len": 60,
                    "r": 6,
                    "vac": 2.5,
                    "vacAlt": 100,
                },
                {
                    "from": E["sii_ign"] + 4,
                    "to": E["sii_cut"],
                    "at": [0, B.Y_SII - 1.4, 0],
                    "len": 28,
                    "r": 3.4,
                    "vac": 0.6,
                    "vacAlt": 100,
                },
                {
                    "from": E["siv_ign"],
                    "to": E["siv_cut"],
                    "at": [0, B.Y_SIVB - 2.2, 0],
                    "len": 18,
                    "r": 1.5,
                    "vac": 0.3,
                    "vacAlt": 100,
                },
                {
                    "from": E["tli_ign"],
                    "to": E["tli_cut"],
                    "at": [0, B.Y_SIVB - 2.2, 0],
                    "len": 22,
                    "r": 1.7,
                    "vac": 0.0,
                    "vacAlt": 100,
                },
            ],
        }
    )
    # the spent stages fall on their own
    V.append(
        fallen(
            fl,
            t_asc,
            y_asc,
            E["oeco"] + 0.1,
            265000.0,
            0.8,
            80.0,
            [part("ms-sic", 0.0)],
            "sic",
        )
    )
    V.append(
        fallen(
            fl,
            t_asc,
            y_asc,
            E["sii_cut"] + 1.0,
            50000.0,
            0.8,
            80.0,
            [part("ms-sii", B.Y_SII)],
            "sii",
        )
    )
    # the third stage, left behind
    stack_rows = np.vstack([r["s"] for r in []]) if False else None
    t_a, Ya = fl.run(y_eject, E["eject"], E["eject"] + 3 * 3600, (), step=60.0)
    sivb_rows = geo_rows(t_a, Ya)
    V.append(
        {
            "id": "sivb",
            "on": E["eject"],
            "off": E["eject"] + 3 * 3600,
            "legs": [eci(sivb_rows, 0.1, max_gap=300.0)],
            "parts": [part("ms-sivb", B.Y_SIVB), part("ms-sla-open", B.Y_SLA)],
            "flames": [],
            "dot": True,
        }
    )

    # ── The command and service modules with the lunar module, to the Moon ──
    t1, Y1 = fl.run(y_eject, E["eject"], E["mcc2"], (), step=60.0)
    rows_pair = [geo_rows(t1, Y1)]
    y_b = out["y_mcc"]
    y_a = out["y_mcc_after"]
    rows_pair.append(np.array([np.concatenate([[E["mcc2"] + 1.0], y_a[0:6]])]))
    t2, Y2 = fl.run(y_a, E["mcc2"], E["loi1"], (), step=60.0)
    rows_pair.append(geo_rows(t2[1:], Y2[1:]))
    y_loi = out["y_loi"]
    tb1, Yb1 = fl.run(
        y_loi, E["loi1"], E["loi1"] + orbit.LOI1_S, (out["loi1"],), step=2.0
    )
    rows_pair.append(geo_rows(tb1[1:], Yb1[1:]))
    t3, Y3 = fl.run(Yb1[-1], E["loi1"] + orbit.LOI1_S, E["loi2"], (), step=30.0)
    rows_pair.append(geo_rows(t3[1:], Y3[1:]))
    y_l2 = out["y_loi2"]
    tb2, Yb2 = fl.run(
        y_l2, E["loi2"], E["loi2"] + orbit.LOI2_S, (out["loi2"],), step=1.0
    )
    rows_pair.append(geo_rows(tb2[1:], Yb2[1:]))
    y_c2 = out["y_cut2"]
    t4, Y4 = fl.run(y_c2, E["loi2"] + orbit.LOI2_S, E["undock"], (), step=30.0)
    rows_pair.append(geo_rows(t4, Y4))
    pair = np.vstack(rows_pair)
    pair = pair[np.argsort(pair[:, 0], kind="stable")]
    keep = np.concatenate([[True], np.diff(pair[:, 0]) > 1e-6])
    pair = pair[keep]
    pair = shifted(pair, lambda t: CSMLM_OFFSET_M)
    pair_leg = eci(pair, 0.03, ref="moon", max_gap=300.0)
    # the LOI burns' flames are in the pair's frame: the bell at the far end, firing forward
    V.append(
        {
            "id": "csmlm",
            "on": E["eject"],
            "off": E["undock"],
            "legs": [pair_leg],
            "parts": [
                part("site-lm", rx=-90),
                part("ms-lm-asc", B.LM_ASC_Z, rx=-90),
                part("ms-csm", 8.0 + 12.4, rx=180),
            ],
            "flames": [
                {
                    "from": E["loi1"],
                    "to": E["loi1"] + orbit.LOI1_S,
                    "at": [0, 8.0 + 12.4 + 2.8 + 7.5, 0],
                    "len": 9,
                    "r": 1.1,
                    "rx": 180,
                },
                {
                    "from": E["loi2"],
                    "to": E["loi2"] + orbit.LOI2_S,
                    "at": [0, 8.0 + 12.4 + 2.8 + 7.5, 0],
                    "len": 9,
                    "r": 1.1,
                    "rx": 180,
                },
            ],
        }
    )
    V += lunar_and_return(fl, out, V)
    return dict(out=out, fl=fl, V=V, pair=pair)


def thrust_up(rows_m, mass_unused=None):
    """Up vectors (the lunar module's own z: where its engine pushes) for Moon-fixed rows [t, r (m), v (m/s)] from the acceleration the path needs."""
    w = np.array([0.0, 0.0, desc.OMEGA_MOON])
    t = rows_m[:, 0]
    out = []
    a = np.gradient(rows_m[:, 4:7], t, axis=0)
    for i in range(len(t)):
        r, v = rows_m[i, 1:4], rows_m[i, 4:7]
        g = -mp.MU_MOON * 1e9 * r / np.linalg.norm(r) ** 3
        thr = a[i] - g + 2 * np.cross(w, v) + np.cross(w, np.cross(w, r))
        out.append(thr / (np.linalg.norm(thr) + 1e-9))
    return np.array(out)


def lunar_and_return(fl, out, V):
    res = []
    st3 = json.load(open(os.path.join(CACHE, "apollo11_stage3.json")))
    y_undock = np.array(st3["y_undock"])
    # ── Columbia alone, to the burn for home ──
    t_c, Y_c = lunar.csm_orbit(fl, out["y_cut2"])
    k = int(np.argmin(abs(t_c - E["undock"])))
    csm_rows = geo_rows(t_c[k:], Y_c[k:])
    rx = json.load(open(os.path.join(CACHE, "apollo11_return.json")))
    x = np.array(rx["x"])
    lun = json.load(open(os.path.join(CACHE, "apollo11_lunar.json")))
    y_base = np.array(lun["y_base"])
    t_base = E["tei"] - ret.TEI_BASE_S
    t0 = ret.tei_start(x[0:4])
    i0 = int(np.argmin(abs(csm_rows[:, 0] - t_base)))
    keep = csm_rows[csm_rows[:, 0] <= t_base]
    ta, Ya = fl.run(y_base, t_base, t0, (), step=30.0)
    burn = Burn(t0, t0 + ret.TEI_S, ret.SPS_THRUST * x[0], ret.SPS_MDOT, sign=1, pitch=(x[1], x[1]), yaw=(x[2], x[2]), rel=fl.moon)
    tb, Yb = fl.run(Ya[-1], t0, t0 + ret.TEI_S, (burn,), step=2.0)
    tc, Yc = fl.run(Yb[-1], t0 + ret.TEI_S, E["mcc5"], (), step=300.0)
    y5 = Yc[-1].copy()
    pf, rad, nrm = ret.vel_frame(y5[0:3], y5[3:6])
    dv5 = x[4:7] * 1e-3
    y5[3:6] = y5[3:6] + dv5[0] * pf + dv5[1] * rad + dv5[2] * nrm
    td, Yd = fl.run(y5, E["mcc5"], E["cm_sm_sep"], (), step=300.0)
    col_rows = np.vstack([keep, geo_rows(ta[1:], Ya[1:]), geo_rows(tb[1:], Yb[1:]), geo_rows(tc[1:], Yc[1:]), np.array([np.concatenate([[E["mcc5"] + 1.0], y5[0:6]])]), geo_rows(td[1:], Yd[1:])])
    col_rows = col_rows[np.argsort(col_rows[:, 0], kind="stable")]
    col_rows = col_rows[np.concatenate([[True], np.diff(col_rows[:, 0]) > 1e-6])]
    col_rows = shifted(col_rows, lambda tt: CSM_IN_PAIR_M)
    columbia = {"id": "columbia", "on": E["undock"], "off": E["cm_sm_sep"],
                "legs": [dict(eci(col_rows[col_rows[:, 0] < E["tei"] - 400], 0.03, ref="moon", max_gap=300.0), att="retro", turn=[E["tei"] - 400, E["tei"] - 120]),
                         eci(col_rows[col_rows[:, 0] >= E["tei"] - 400], 0.05, ref="earth", max_gap=900.0)],
                "parts": [part("ms-csm", 0.0)] + [dict(part("site-lm", 0.0), **{"from": 1e12})],
                "flames": [{"from": t0, "to": t0 + ret.TEI_S, "at": [0, -2.8, 0], "len": 9, "r": 1.1}]}
    columbia["parts"] = [part("ms-csm", 0.0), part("ms-lm-asc", 12.4 + 2.2, rx=90, **{"from": B.EXTRA["dock2"], "to": B.EXTRA["jettison"]})]
    res.append(columbia)
    # ── Eagle ──
    (t_l, Y_l), y_pdi = lm.lm_to_pdi(fl, y_undock, st3["kappa_doi"])
    lm_rows = geo_rows(t_l, Y_l)
    t_d, y_d, xb = desc.descent(fl, y_pdi, verbose=False)
    rows_m = np.hstack([t_d[:, None], y_d[:, 0:6]])
    up = thrust_up(rows_m)
    km = np.hstack([t_d[:, None], y_d[:, 0:3] / 1000.0, y_d[:, 3:6] / 1000.0, up])
    leg_eci = eci(lm_rows, 0.03, ref="moon", max_gap=120.0)
    leg_desc = {"frame": "mcmf", "ref": "moon", "s": pack(thin(km[:, 0:7], 0.003, 20.0), 4, 6), "sd": 150}
    leg_desc["s"] = _with_up(km, leg_desc["s"])
    res.append({"id": "eagle", "on": E["undock"], "off": E["landing"], "legs": [leg_eci, leg_desc],
                "parts": [part("site-lm"), part("ms-lm-asc", B.LM_ASC_Z)],
                "flames": [{"from": E["doi"], "to": E["doi"] + lm.DOI_S, "at": [0, 0, 1.0], "len": 3.0, "r": 0.4, "rx": 90},
                           {"from": E["pdi"], "to": E["landing"], "at": [0, 0, 1.0], "len": 7.0, "r": 0.7, "rx": 90}]})
    site = km[-1]
    stay = {"frame": "mcmf", "ref": "moon", "att": "level", "s": [[E["landing"], *[round(float(v), 5) for v in site[1:4]], 0, 0, 0], [E["liftoff_moon"] + 5.0, *[round(float(v), 5) for v in site[1:4]], 0, 0, 0]]}
    res.append({"id": "eagle_surface", "on": E["landing"], "off": E["liftoff_moon"], "legs": [stay], "parts": [part("site-lm"), part("ms-lm-asc", B.LM_ASC_Z)], "flames": [], "dot": False})
    stay2 = dict(stay, s=[[E["liftoff_moon"], *[round(float(v), 5) for v in site[1:4]], 0, 0, 0], [E["splash"] + 120.0, *[round(float(v), 5) for v in site[1:4]], 0, 0, 0]])
    res.append({"id": "eagle_base", "on": E["liftoff_moon"], "off": E["splash"] + 120.0, "legs": [stay2], "parts": [part("site-lm")], "flames": [], "dot": False})
    # ── Eagle's ascent stage: the climb, the coast, and the arc of the terminal phase to Columbia ──
    res.append(ascent_vehicle(fl, t_c, Y_c))
    # ── Back to Earth: the service module lets go; the command module enters ──

    sm_rows = shifted(col_rows[col_rows[:, 0] >= E["cm_sm_sep"] - 600], lambda tt: -0.6 * max(0.0, tt - E["cm_sm_sep"]))
    entry_leg_rows = fl.run(Yd[-1], E["cm_sm_sep"], E["entry"], (), step=10.0)
    tE, YE = entry_leg_rows
    pre = geo_rows(tE, YE)
    sm_leg = eci(shifted(pre, lambda tt: -0.6 * (tt - E["cm_sm_sep"])), 0.1, max_gap=60.0)
    res.append({"id": "sm", "on": E["cm_sm_sep"], "off": E["entry"] + 120.0, "legs": [sm_leg], "parts": [part("ms-sm", 0.0)], "flames": [], "dot": True})
    ex = json.load(open(os.path.join(CACHE, "apollo11_entry.json")))["x"]
    ent_t, ent_Y = ent.fly(np.array(YE[-1]), ex)
    i_dr = ent.until_drogue(ent_t, ent_Y)
    ent_rows = np.array([np.concatenate([[ti], path.ecef_state(ti, yi)]) for ti, yi in zip(ent_t[: i_dr + 1], ent_Y[: i_dr + 1])])
    cm_leg1 = eci(pre, 0.02, att="retro", max_gap=30.0)
    cm_leg2 = {"frame": "ecef", "ref": "earth", "att": "retro", "s": pack(thin(ent_rows, 0.03, 10.0), 4, 6)}
    # under the parachutes: from the drogue's altitude to the sea in ground-fixed rows (drifting a little with the wind)
    p0 = ent_rows[-1]
    drogue_t, splash_t = ent_rows[-1, 0], E["splash"]
    main_t = splash_t - 353.0
    lat0 = math_lat_lon_alt(p0[1:4])
    from_alt, to_alt = lat0[2], 0.0
    chute_rows = []
    for tt in np.linspace(drogue_t, splash_t, 40):
        if tt < main_t:
            f = (tt - drogue_t) / (main_t - drogue_t)
            alt = from_alt + (3.0 - from_alt) * (1 - (1 - f) ** 2)
        else:
            alt = 3.0 * (1 - (tt - main_t) / (splash_t - main_t))
        chute_rows.append((tt, alt))
    base_dir = p0[1:4] / np.linalg.norm(p0[1:4])
    prows = []
    for (tt, alt) in chute_rows:
        r = base_dir * (mp.R_EARTH + alt + 0.0)
        prows.append(np.concatenate([[tt], r, [0, 0, 0]]))
    prows = np.array(prows)
    cm_leg3 = {"frame": "ecef", "ref": "earth", "att": "level", "s": pack(prows, 4, 6), "sd": 8}
    res.append({"id": "cm", "on": E["cm_sm_sep"], "off": E["splash"] + 90.0, "legs": [cm_leg1, cm_leg2, cm_leg3],
                "parts": [part("ms-cm", 0.0, to=drogue_t), dict(part("ms-cm", 0.0, rx=90, **{"from": drogue_t}))], "flames": [], "dot": True})
    return res


def ascent_vehicle(fl, t_c, Y_c):
    """The lunar module's ascent stage from the surface to the docking, as one vehicle."""
    import mission_apollo11_ascent as asc
    from mission_apollo11_moon import sel
    from mission_lambert import lambert

    tl = E["liftoff_moon"]
    k = int(np.argmin(abs(t_c - tl)))
    ycsm = fl.run(Y_c[k], t_c[k], tl, (), step=None)[1][-1] if abs(t_c[k] - tl) > 0.5 else Y_c[k]
    r, v = sel(fl, tl, ycsm)
    plane = np.cross(r, v)
    plane /= np.linalg.norm(plane)
    x = asc.fit_climb(fl, plane, verbose=False)
    tt, yy = asc.climb(fl, plane, x)
    rows_fixed = []
    for ti, yi in zip(tt, yy):
        F = moon_fixed_matrix(ti)
        rf = F @ yi[0:3]
        rows_fixed.append(np.concatenate([[ti], rf, F @ yi[3:6] - np.cross([0.0, 0.0, desc.OMEGA_MOON], rf)]))
    rows_fixed = np.array(rows_fixed)
    leg1 = {"frame": "mcmf", "ref": "moon", "att": "level", "s": pack(thin(rows_fixed, 0.003, 20.0), 4, 6), "sd": 30}
    pm, vm = fl.moon.state(tt[-1])
    yg = np.concatenate([yy[-1, 0:3] + pm, yy[-1, 3:6] + vm, [yy[-1, 6]]])
    tpi, dock = B.EXTRA["tpi"], B.EXTRA["dock2"]
    ta, Ya = fl.run(yg, tt[-1], tpi, (), step=20.0)
    j = int(np.argmin(abs(t_c - dock)))
    ycd = fl.run(Y_c[j], t_c[j], dock, (), step=None)[1][-1] if abs(t_c[j] - dock) > 0.5 else Y_c[j]
    pt, vt = fl.moon.state(tpi)
    pd, vd = fl.moon.state(dock)
    hk = np.cross(Ya[-1][0:3] - pt, Ya[-1][3:6] - vt)
    v1, _ = lambert(Ya[-1][0:3] - pt, ycd[0:3] - pd, dock - tpi, mp.MU_MOON, prograde=True, normal=hk)
    y1 = Ya[-1].copy()
    y1[3:6] = v1 + vt
    tb, Yb = fl.run(y1, tpi, dock, (), step=10.0)
    arc = geo_rows(tb, Yb)
    delta = ycd[0:3] - Yb[-1][0:3]
    u = (arc[:, 0] - tpi) / (dock - tpi)
    sm = u * u * (3 - 2 * u)
    arc[:, 1:4] += delta[None, :] * sm[:, None]
    arc[:, 4:7] += delta[None, :] * (6 * u * (1 - u) / (dock - tpi))[:, None]
    rows = np.vstack([geo_rows(ta, Ya), arc[1:]])
    return {"id": "eagle_asc", "on": tl, "off": dock, "legs": [leg1, eci(rows, 0.03, ref="moon", max_gap=120.0, sd=120)],
            "parts": [part("ms-lm-asc", 0.0)],
            "flames": [{"from": tl, "to": tl + asc.BURN_S, "at": [0, 0, -0.4], "len": 3.0, "r": 0.35, "rx": 90}]}


def moon_fixed_matrix(t):
    from mission_apollo11_moon import fixed_matrix

    return fixed_matrix(t)


def math_lat_lon_alt(p):
    lat, lon, alt = mp.ecef_to_geodetic(p)
    return lat, lon, alt


def _with_up(km, packed):
    """The packed rows of a leg with the up vectors of the kept times added."""
    by_t = {round(float(r[0]), 2): r for r in km}
    out = []
    for row in packed:
        src = by_t.get(round(row[0], 2))
        if src is None:
            i = int(np.argmin(abs(km[:, 0] - row[0])))
            src = km[i]
        out.append(list(row[0:7]) + [round(float(v), 4) for v in src[7:10]])
    return out


if __name__ == "__main__":
    r = assemble(verbose=True)
    print(len(r["V"]), "vehicles")
