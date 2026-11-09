"""Apollo 11 after the climb: the parking orbit, translunar injection, the coast and the first midcourse correction. Each
stage is solved against the numbers in the mission report (mission_apollo11.py lists the sources), so the path meets the
report's events, positions and speeds; it is a reconstruction, not NASA's tracking data (none of Columbia's exists in
JPL Horizons, only the S-IVB's, from 27 hours on)."""

import json
import math
import os

import numpy as np
from scipy.optimize import least_squares

from mission_apollo11 import EVENTS, ZERO_JD, fit_ascent
from mission_flight import Burn, Flight, burn_mdot
from mission_physics import (
    CACHE,
    MU_EARTH,
    MU_MOON,
    OMEGA_EARTH,
    R_EARTH,
    R_MOON,
    Ephemeris,
    earth_pole_ecl,
    ecef_to_ecl,
    ecef_to_geodetic,
    horizons,
)

NMI = 1.852
FPS = 0.0003048
ISP_J2 = 421.0
TLI_MDOT = 208.0  # kg/s; 72.2 t in the 347 s burn
TLI_THRUST = TLI_MDOT * ISP_J2 * 9.80665  # N
SPS_THRUST, SPS_ISP = 93.9e3, 314.0
SPS_MDOT = burn_mdot(SPS_THRUST, SPS_ISP)


def ecef_state(t, y):
    """An inertial state at t as Earth-fixed position and velocity relative to the turning Earth."""
    jd = ZERO_JD + t / 86400
    rot = ecef_to_ecl(jd).T
    spin = OMEGA_EARTH * earth_pole_ecl(jd)
    return np.concatenate([rot @ y[0:3], rot @ (y[3:6] - np.cross(spin, y[0:3]))])


def geodetic_of(t, r):
    p = ecef_to_ecl(ZERO_JD + t / 86400).T @ r
    lat, lon, alt = ecef_to_geodetic(p)
    return lat, ((lon + 180) % 360) - 180, alt


def ephemerides():
    moon = Ephemeris(
        horizons("301", "1969-07-16 12:00", "1969-07-25 12:00", "1h"), ZERO_JD
    )
    sun = Ephemeris(
        horizons("10", "1969-07-16 12:00", "1969-07-25 12:00", "1h"), ZERO_JD
    )
    return moon, sun


def load_ascent():
    path = os.path.join(CACHE, "apollo11_ascent.json")
    if os.path.exists(path):
        with open(path) as fh:
            d = json.load(fh)
        return np.array(d["t"]), np.array(d["y"])
    x, (t, y) = fit_ascent(verbose=False)
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as fh:
        json.dump({"x": list(map(float, x)), "t": t.tolist(), "y": y.tolist()}, fh)
    return t, y


def closest_moon(flight, t0, y0, t1, burns=(), step=300.0):
    """(time, distance km) of the closest approach to the Moon between t0 and t1, and the state there."""
    t, y = flight.run(y0, t0, t1, burns, step=step, rtol=1e-10)
    d = np.array(
        [np.linalg.norm(y[i, 0:3] - flight.moon.pos(t[i])) for i in range(len(t))]
    )
    i = int(np.argmin(d))
    lo, hi = t[max(i - 1, 0)], t[min(i + 1, len(t) - 1)]
    t2, y2 = flight.run(y[max(i - 1, 0)], lo, hi, (), step=2.0, rtol=1e-11)
    d2 = np.array(
        [np.linalg.norm(y2[k, 0:3] - flight.moon.pos(t2[k])) for k in range(len(t2))]
    )
    j = int(np.argmin(d2))
    return t2[j], d2[j], y2[j]


def approach_inclination(flight, t, y):
    """The inclination to the lunar equator of the path about the Moon at the state y (a geocentric state at t)."""
    from mission_apollo11_moon import fixed_matrix

    pm, vm = flight.moon.state(t)
    h = np.cross(y[0:3] - pm, y[3:6] - vm)
    pole = fixed_matrix(t).T @ np.array([0.0, 0.0, 1.0])
    return math.degrees(math.acos(np.dot(h, pole) / np.linalg.norm(h)))


def moon_pole_ecl():
    from mission_physics import moon_fixed_to_ecl

    return moon_fixed_to_ecl(ZERO_JD + 3.2) @ np.array([0.0, 0.0, 1.0])


def build_translunar(verbose=True):
    """Parking orbit, TLI, coast, MCC-2. Returns the pieces other stages continue from."""
    moon, sun = ephemerides()
    t_asc, y_asc = load_ascent()
    pole = earth_pole_ecl(ZERO_JD)
    fl = Flight(moon, sun, pole)
    y_cut = y_asc[-1]
    tc = t_asc[-1]
    t_ign = EVENTS["tli_ign"]
    t_cut = EVENTS["tli_cut"]
    t_inj = EVENTS["tli"]
    t_loi = EVENTS["loi1"]
    t_park, y_park = fl.run(y_cut, tc, t_ign, (), step=10.0)
    lat, lon, alt = geodetic_of(t_ign, y_park[-1, 0:3])
    if verbose:
        print(
            "TLI ignition  got  lat %.2f lon %.2f alt %.1f km  speed %.4f"
            % (lat, lon, alt, np.linalg.norm(y_park[-1, 3:6]))
        )
        print(
            "              want lat -8.03 lon 172.55 alt %.1f km  speed %.4f"
            % (105.8 * NMI, 25562 * FPS)
        )
    y_ign = y_park[-1].copy()

    # TLI: the thrust scale, the burn's pitch and yaw (each at the start and the end) against the report: the cut-off speed,
    # the injection point, the pericynthion altitude it gave (896.3 miles) and when.
    want_speed = 35567 * FPS
    want_peri = 896.3 * NMI
    want_peri_t = t_loi + 170.0
    want_inc = 178.7  # the lunar orbits were retrograde and 1.3 degrees from the equator (the ground track runs west)

    def tli_burn(x):
        return Burn(
            t_ign,
            t_cut,
            TLI_THRUST * x[0],
            TLI_MDOT,
            pitch=(x[1], x[2]),
            yaw=(x[3], x[4]),
        )

    def tli_resid(x, full=False):
        b = tli_burn(x)
        t, y = fl.run(y_ign, t_ign, t_inj, (b,), step=None)
        speed_cut = None
        tt, yy = fl.run(y_ign, t_ign, t_cut, (b,), step=None)
        speed_cut = np.linalg.norm(yy[-1, 3:6])
        lat_i, lon_i, alt_i = geodetic_of(t_inj, y[-1, 0:3])
        tp, dp, yp = closest_moon(fl, t_inj, y[-1], t_loi + 6 * 3600, step=600.0)
        inc = approach_inclination(fl, tp, yp)
        r = [
            (speed_cut - want_speed) * 50,
            (lat_i - 9.98) / 1.5,
            (lon_i + 164.84) / 3.0,
            (dp - R_MOON - want_peri) / 100.0,
            (tp - want_peri_t) / 300.0,
            (inc - want_inc) / 0.4,
            x[2] * 0.3,
            x[4] * 0.3,
            (x[1]) * 0.3,
            x[3] * 0.3,
        ]
        if full:
            return r, y[-1], (lat_i, lon_i, alt_i, speed_cut, dp - R_MOON, tp, inc)
        return r

    cache = os.path.join(CACHE, "apollo11_tli.json")
    if os.path.exists(cache):
        with open(cache) as fh:
            x_fit = np.array(json.load(fh))
    else:
        x0 = np.array([1.0, 0.0, 0.0, 0.0, 0.0])
        sol = least_squares(tli_resid, x0, diff_step=1e-4, max_nfev=120, x_scale=[0.02, 0.05, 0.05, 0.05, 0.05])
        x_fit = sol.x
        with open(cache, "w") as fh:
            json.dump([float(v) for v in x_fit], fh)

    class _Sol:
        x = x_fit

    sol = _Sol()
    r, y_inj, info = tli_resid(sol.x, full=True)
    if verbose:
        print("TLI x", sol.x.round(5))
        print(
            "TLI got lat %.2f lon %.2f alt %.0f speed %.4f  peri alt %.0f km at t=%.0f (want %.0f km at %.0f) incl %.2f"
            % (
                info[0],
                info[1],
                info[2],
                info[3],
                info[4],
                info[5],
                want_peri,
                want_peri_t,
                info[6],
            )
        )
    return dict(
        fl=fl,
        y_ign=y_ign,
        tli_x=sol.x,
        tli_burn=tli_burn(sol.x),
        y_inj=y_inj,
        t_park=t_park,
        y_park=y_park,
    )


if __name__ == "__main__":
    build_translunar()
