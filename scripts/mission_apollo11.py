"""Apollo 11, flown: the numbers and the reconstruction. Sources, by the abbreviations used in the comments:

MR   Apollo 11 Mission Report, MSC-00171 (NASA NTRS 19710015566): the sequence of events (table 3-I), trajectory
     parameters (7-II), powered descent (5-I, 5-III), entry (7-VII), mass properties (B-I)
SV   Saturn V Flight Manual, SA-506 (MSFC-MAN-503) for the stack's masses, thrusts and burn times, rounded
JPL  Horizons: the Moon's and the Sun's places (no ephemeris of Columbia or Eagle exists: the spacecraft's own
     path is integrated here from the mission report's events and states)
"""

import math

import numpy as np
from scipy.optimize import least_squares

from mission_ascent import Vehicle, ascent
from mission_physics import MU_EARTH, R_EARTH, elements, earth_pole_ecl, jd_of

# Range zero 13:32:00 UT, 16 July 1969 (MR table 3-I); lift-off 0.6 s later.
ZERO_JD = jd_of(1969, 7, 16, 13, 32, 0.0)
PAD = (28.6083, -80.6041)  # Launch Complex 39A
LAUNCH_S = 0.6
AZIMUTH_DEG = (
    72.058  # the pad's launch azimuth, degrees east of north (MR 'Launch Phase')
)


def hms(h, m, s=0.0):
    return h * 3600 + m * 60 + s


# MR table 3-I, seconds from range zero.
EVENTS = {
    "liftoff": LAUNCH_S,
    "oeco": hms(0, 2, 41.7),
    "sii_ign": hms(0, 2, 43.0),
    "let": hms(0, 3, 17.9),
    "sii_cut": hms(0, 9, 8.3),
    "siv_ign": hms(0, 9, 12.2),
    "siv_cut": hms(0, 11, 39.3),
    "tli_ign": hms(2, 44, 16.2),
    "tli_cut": hms(2, 50, 3.2),
    "tli": hms(2, 50, 13.2),
    "csm_siv_sep": hms(3, 17, 4.6),
    "dock": hms(3, 24, 3.1),
    "eject": hms(4, 16, 59.1),
    "mcc2": hms(26, 44, 58.6),
    "loi1": hms(75, 49, 50.4),
    "loi2": hms(80, 11, 36.8),
    "undock": hms(100, 12, 0.0),
    "doi": hms(101, 36, 14.0),
    "pdi": hms(102, 33, 5.0),
    "landing": hms(102, 45, 39.9),
    "liftoff_moon": hms(124, 22, 0.8),
    "tei": hms(135, 23, 42.3),
    "mcc5": hms(150, 29, 57.4),
    "cm_sm_sep": hms(194, 49, 12.7),
    "entry": hms(195, 3, 5.7),
    "splash": hms(195, 18, 35.0),
}
# Orbit insertion, the parking orbit the report gives: 100.7 x 99.2 nautical miles.
NMI = 1.852
PARKING = {"apogee_km": 100.7 * NMI, "perigee_km": 99.2 * NMI, "inc_deg": 32.521}

# The stack at lift-off (SV, rounded). Masses in kg.
S_IC_MDOT = 13300.0
S_II_MDOT = 1209.0
S_IVB_MDOT = 242.0


def saturn_v():
    """SA-506 as a Vehicle: three stages, the centre engines shut down early on the first two."""
    e = EVENTS
    stages = [
        dict(
            t0=e["liftoff"],
            t1=e["oeco"],
            thrust_sl=34.5e6,
            thrust_vac=39.0e6,
            mdot=S_IC_MDOT,
            cut=(135.2, 0.8),
        ),
        dict(
            t0=e["sii_ign"] + 4.0,
            t1=e["sii_cut"],
            thrust_sl=0.0,
            thrust_vac=5.0e6,
            mdot=S_II_MDOT,
            cut=(460.6, 0.8),
        ),
        dict(
            t0=e["siv_ign"],
            t1=e["siv_cut"],
            thrust_sl=0.0,
            thrust_vac=1.0e6,
            mdot=S_IVB_MDOT,
        ),
    ]
    drops = [
        (e["oeco"] + 0.1, 135000.0 + 70000.0),  # the S-IC and the propellant it did not burn
        (169.0, 5500.0),  # the interstage
        (e["let"], 4000.0),  # the launch escape tower
        (e["sii_cut"] + 1.0, 46000.0 + 600.0),  # the S-II
    ]
    return Vehicle(2938000.0, stages, drops, cd=0.5, area_m2=80.0)


# The first stage flies the pitch program the launch view already uses (12 s up, then 1.2 deg per s^0.78); the second and third
# fly a linear tangent, tan(elevation) = c0 - c1 (t - t0), the form the Saturn V's iterative guidance converges to.
FIRST_TILT = dict(start=12.0, per=1.2, pow=0.78, max_deg=62.0)


def tilt_program(c0, c1, per=None):
    t_sii = EVENTS["sii_ign"]
    per = FIRST_TILT["per"] if per is None else per

    def f(t):
        if t < t_sii:
            if t < FIRST_TILT["start"]:
                return 0.0
            return math.radians(min(FIRST_TILT["max_deg"], per * (t - FIRST_TILT["start"]) ** FIRST_TILT["pow"]))
        el = math.atan(max(c0 - c1 * (t - t_sii), 0.0))
        return math.pi / 2 - el

    return f


# Where the report puts the first burn of translunar injection (MR table 7-II): 8.03 S, 172.55 E, 105.8 nautical miles up,
# going north. The parking orbit's plane is the one with the report's inclination through that point; the climb is flown in it.
TLI_IGNITION = dict(lat=-8.03, lon=172.55, alt_km=105.8 * 1.852)


def target_plane():
    from mission_physics import ecef_to_ecl, geodetic_to_ecef

    jd = ZERO_JD + EVENTS["tli_ign"] / 86400
    r = ecef_to_ecl(jd) @ geodetic_to_ecef(TLI_IGNITION["lat"], TLI_IGNITION["lon"], TLI_IGNITION["alt_km"])
    e1 = r / np.linalg.norm(r)
    p = earth_pole_ecl(ZERO_JD)
    perp = p - np.dot(p, e1) * e1
    n = np.linalg.norm(perp)
    e2 = perp / n
    e3 = np.cross(e1, e2)
    x = math.cos(math.radians(PARKING["inc_deg"])) / n
    y = math.sqrt(max(0.0, 1 - x * x))
    for sign in (1, -1):
        h = x * e2 + sign * y * e3
        if np.dot(np.cross(h, e1), p) > 0:  # going north there
            return h
    raise RuntimeError("no plane")


def scaled_saturn(kappa, eta=1.0):
    """The stack with the upper stages' thrust scaled by kappa (their effective Isp: the fit's one allowance for what a
    point mass leaves out) and the first stage's by eta."""
    veh = saturn_v()
    for s in veh.stages[1:]:
        s["thrust_vac"] *= kappa
    veh.stages[0]["thrust_sl"] *= eta
    veh.stages[0]["thrust_vac"] *= eta
    return veh


def climb(x, until=None):
    """x = [c0, c1, kappa, azimuth, first-stage pitch rate, eta]: the stack's climb to the S-IVB cut-off (to `until` seconds)."""
    veh = scaled_saturn(x[2], x[5] if len(x) > 5 else 1.0)
    return ascent(veh, PAD[0], PAD[1], ZERO_JD, tilt_program(x[0], x[1], x[4]), x[3], LAUNCH_S, until or EVENTS["siv_cut"], step=1.0, plane=target_plane())


def alt_oeco(t, y):
    i = int(np.argmin(abs(t - EVENTS["oeco"])))
    return float(np.linalg.norm(y[i, :3]) - R_EARTH)


def fit_ascent(verbose=True):
    """Fit the upper stages' tangent, their thrust (a few per cent) and the heading to the report's parking orbit."""
    pole = earth_pole_ecl(ZERO_JD)

    def resid(x):
        t, y = climb(x)
        r, v = y[-1, 0:3], y[-1, 3:6]
        el = elements(r, v, MU_EARTH)
        inc = math.degrees(math.acos(np.dot(el["h"], pole) / np.linalg.norm(el["h"])))
        return [(el["rp"] - R_EARTH - PARKING["perigee_km"]) / 2, (el["ra"] - R_EARTH - PARKING["apogee_km"]) / 2,
                (inc - PARKING["inc_deg"]) * 30, (x[2] - 1.0) * 0.2]

    x0 = np.array([0.6, 0.0015, 1.0, 74.0, FIRST_TILT["per"]])
    sol = least_squares(resid, x0, bounds=([0.0, 0.0, 0.9, 65.0, 0.8], [3.0, 0.02, 1.1, 82.0, 1.8]), diff_step=1e-4,
                        x_scale=[0.1, 0.001, 0.02, 1.0, 0.05], max_nfev=60, verbose=2 if verbose else 0)
    return sol.x, climb(sol.x)


def save_ascent(x, t, y):
    import json
    import os

    from mission_physics import CACHE

    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "apollo11_ascent.json"), "w") as fh:
        json.dump({"x": [float(v) for v in x], "t": t.tolist(), "y": y.tolist()}, fh)


if __name__ == "__main__":
    x, (t, y) = fit_ascent()
    save_ascent(x, t, y)
    print("x", x)
    r, v = y[-1, 0:3], y[-1, 3:6]
    el = elements(r, v, MU_EARTH)
    print("perigee", el["rp"] - R_EARTH, "apogee", el["ra"] - R_EARTH, "speed", np.linalg.norm(v), "mass", y[-1, 6])
    i = int(np.argmin(abs(t - EVENTS["oeco"])))
    print("OECO alt", np.linalg.norm(y[i, :3]) - R_EARTH, "mass", y[i, 6])
