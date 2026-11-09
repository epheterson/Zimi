"""Apollo 11's phases and events for the mission player: names (keys of the interface's strings, English beside them), when, how fast the clock runs through
each, and where the camera stands. Times are seconds from range zero (MR table 3-I and 5-I).
"""

from mission_apollo11 import EVENTS as E
from mission_apollo11_build import EXTRA as X

K = "alm_ms_"


def ph(t, key, en, w, rate, follow, cam, ref="earth", **kw):
    d = {
        "t": t,
        "k": K + "ph_" + key,
        "en": en,
        "w": w,
        "rate": rate,
        "follow": follow,
        "cam": cam,
        "ref": ref,
    }
    d.update(kw)
    return d


def ev(t, key, en, icon="dot"):
    return {
        "t": round(float(t), 1),
        "k": (K + "ev_" + key) if key else None,
        "en": en,
        "icon": icon,
    }


def phases():
    return [
        ph(
            -15.0,
            "launch",
            "Launch",
            1.5,
            1,
            "stack",
            {"d": 230, "az": 80, "el": -8, "look": [0, 50, 0]},
            far=False,
        ),
        ph(
            E["oeco"],
            "stage2",
            "Second stage",
            1.0,
            3,
            "stack",
            {"d": 110, "az": 70, "el": 10, "look": [0, 55, 0]},
            far=False,
        ),
        ph(
            E["sii_cut"],
            "stage3",
            "Third stage",
            0.8,
            3,
            "stack",
            {"d": 70, "az": 60, "el": 12, "look": [0, 70, 0]},
            far=False,
        ),
        ph(
            E["siv_cut"],
            "park",
            "Parking orbit",
            0.8,
            120,
            "stack",
            {"d": 90, "az": 50, "el": 15, "look": [0, 75, 0]},
            far=False,
        ),
        ph(
            E["tli_ign"] - 120,
            "tli",
            "Trans-lunar injection",
            0.8,
            5,
            "stack",
            {"d": 60, "az": 100, "el": 8, "look": [0, 70, 0]},
            far=False,
        ),
        ph(
            E["csm_siv_sep"] - 60,
            "dock",
            "Docking",
            1.1,
            8,
            "stack",
            {"d": 60, "az": 60, "el": 10, "look": [0, 100, 0]},
            far=False,
        ),
        ph(
            E["eject"] + 600,
            "coast",
            "Coast to the Moon",
            1.2,
            3000,
            "csmlm",
            {"body": "earth", "d": 6e7, "az": 0.3, "el": 0.2, "mix": 0.4},
        ),
        ph(
            E["loi1"] - 3 * 3600,
            "approach",
            "Approach",
            0.8,
            600,
            "csmlm",
            {"body": "moon", "d": 1.2e7, "az": 0.5, "el": 0.25, "mix": 0.5},
            ref="moon",
        ),
        ph(
            E["loi1"] - 300,
            "loi",
            "Lunar orbit insertion",
            1.0,
            10,
            "csmlm",
            {"d": 70, "az": 80, "el": 10, "look": [0, 12, 0]},
            ref="moon",
            far=False,
        ),
        ph(
            E["loi2"] + 200,
            "lunar_orbit",
            "Lunar orbit",
            0.8,
            900,
            "csmlm",
            {"d": 50, "az": 70, "el": 14, "look": [0, 12, 0]},
            ref="moon",
        ),
        ph(
            E["pdi"] - 60,
            "descent",
            "Powered descent",
            1.3,
            1.5,
            "eagle",
            {"d": 38, "az": 110, "el": 10, "look": [0, 0, 2]},
            ref="moon",
            far=False,
        ),
        ph(
            EXTRA["p64"],
            "descent",
            "Powered descent",
            1.0,
            1.5,
            "eagle",
            {"d": 28, "az": 90, "el": 25, "look": [0, 0, 1]},
            ref="moon",
            far=False,
        ),
        ph(
            E["landing"] + 20,
            "surface",
            "On the Moon",
            0.8,
            3600,
            "eagle_surface",
            {"d": 26, "az": 60, "el": 20, "look": [0, 0, 3]},
            ref="moon",
            far=False,
        ),
    ]


def events():
    G = EXTRA
    return [
        ev(-6.5, "liftoff", "Ignition", "burn"),
        ev(E["liftoff"], "liftoff", "Liftoff", "burn"),
        ev(G["ceco"], "ceco", "Centre engine cutoff", "split"),
        ev(E["oeco"], "oeco", "First stage cutoff", "split"),
        ev(E["sii_ign"], "sii_ign", "Second stage ignition", "burn"),
        ev(E["let"], "let", "Escape tower jettison", "split"),
        ev(E["sii_cut"], "sii_cut", "Second stage cutoff", "split"),
        ev(E["siv_ign"], "siv_ign", "Third stage ignition", "burn"),
        ev(E["siv_cut"], "orbit", "In orbit", "dot"),
        ev(E["tli_ign"], "tli_ign", "Injection burn", "burn"),
        ev(E["tli_cut"], "tli_cut", "Injection complete", "dot"),
        ev(E["csm_siv_sep"], "transpose", "Transposition", "split"),
        ev(E["dock"], "docked", "Docked", "dot"),
        ev(E["eject"], "eject", "Spacecraft ejection", "split"),
        ev(E["mcc2"], "mcc", "Midcourse correction", "burn"),
        ev(E["loi1"], "loi1", "Lunar orbit insertion", "burn"),
        ev(E["loi2"], "loi2", "Circularisation", "burn"),
        ev(E["undock"], "undock", "Undocking", "split"),
        ev(E["doi"], "doi", "Descent orbit insertion", "burn"),
        ev(E["pdi"], "pdi", "Descent begins", "burn"),
        ev(G["alarm1"], None, "1202", "alarm"),
        ev(G["alarm2"], None, "1202", "alarm"),
        ev(G["p64"], "p64", "High gate", "dot"),
        ev(G["alarm3"], None, "1201", "alarm"),
        ev(G["alarm4"], None, "1202", "alarm"),
        ev(G["alarm5"], None, "1202", "alarm"),
        ev(G["p66"], "manual", "Manual control", "dot"),
        ev(E["landing"], "touchdown", "The Eagle has landed", "dot"),
        ev(G["first_step"], "eva", "First step", "dot"),
        ev(E["liftoff_moon"], "liftoff_moon", "Liftoff from the Moon", "burn"),
        ev(G["insertion_moon"], "insertion", "In lunar orbit", "dot"),
        ev(G["csi"], "csi", "Phasing burn", "burn"),
        ev(G["dock2"], "dock2", "Docking", "dot"),
        ev(G["jettison"], "jettison", "Eagle left behind", "split"),
        ev(E["tei"], "tei_ign", "Burn for home", "burn"),
        ev(E["mcc5"], "mcc", "Midcourse correction", "burn"),
        ev(E["cm_sm_sep"], "sm_sep", "Service module separation", "split"),
        ev(E["entry"], "ei", "Entry interface", "dot"),
        ev(G["drogue"], "drogue", "Drogue parachutes", "dot"),
        ev(E["splash"] - 353.0, "main", "Main parachutes", "dot"),
        ev(E["splash"], "splash", "Splashdown", "dot"),
    ]
