"""A launch vehicle's climb to orbit, integrated from the pad: a point mass on the rotating Earth, thrust along a pitch
program, drag, J2 and a staged mass. build_missions.py fits the program so the orbit it reaches is the one the mission
report gives. Units km, km/s, s; frame ecliptic J2000 (mission_physics)."""

import math

import numpy as np
from scipy.integrate import solve_ivp

from mission_physics import (
    J2_EARTH,
    MU_EARTH,
    OMEGA_EARTH,
    R_EARTH,
    earth_pole_ecl,
    ecef_to_ecl,
    geodetic_to_ecef,
    unit,
)

RHO0 = 1.225
SCALE_H_KM = 7.2
PLANE_GAIN = 4.0  # radians of yaw per unit of out-of-plane distance


class Vehicle:
    """A stack. `stages`: dicts with t0, t1 (burn), thrust_sl, thrust_vac (N), mdot (kg/s) and optionally cut=(t, share):
    from t the thrust and flow are that share (a centre engine shut down). `drops`: (t, kg) of mass left behind.
    """

    def __init__(self, mass0, stages, drops, cd, area_m2):
        self.mass0, self.stages, self.drops, self.cd, self.area = (
            mass0,
            stages,
            drops,
            cd,
            area_m2,
        )

    def burn(self, t):
        for s in self.stages:
            if s["t0"] <= t < s["t1"]:
                k = s["cut"][1] if "cut" in s and t >= s["cut"][0] else 1.0
                return s["thrust_sl"] * k, s["thrust_vac"] * k, s["mdot"] * k
        return 0.0, 0.0, 0.0

    def edges(self):
        e = set()
        for s in self.stages:
            e.update([s["t0"], s["t1"]])
            if "cut" in s:
                e.add(s["cut"][0])
        e.update(d[0] for d in self.drops)
        return e


def ascent(
    veh, pad_lat, pad_lon, jd_zero, program, azimuth_deg, t_launch, t_end, step=1.0, plane=None
):
    """From the pad at t_launch (seconds from the mission's zero) to t_end. `program(t)`: tilt from vertical, radians, with the
    inertial heading `azimuth_deg` (from north), or, with `plane` (the unit normal of the orbit's plane, ecliptic J2000), held in
    that plane with a correction for the pad's distance from it. Returns times and rows [x, y, z, vx, vy, vz, mass].
    """
    jd0 = jd_zero + t_launch / 86400
    r0 = ecef_to_ecl(jd0) @ geodetic_to_ecef(pad_lat, pad_lon, 0.0)
    pole = earth_pole_ecl(jd0)
    spin = OMEGA_EARTH * pole
    v0 = np.cross(spin, r0)
    az = math.radians(azimuth_deg)
    k_j2 = 1.5 * J2_EARTH * MU_EARTH * R_EARTH**2

    def f(t, y):
        r, v, m = y[0:3], y[3:6], y[6]
        rn = np.linalg.norm(r)
        up = r / rn
        east = unit(np.cross(pole, up))
        north = np.cross(up, east)
        tilt = program(t)
        if plane is None:
            horiz = math.cos(az) * north + math.sin(az) * east
        else:
            horiz = unit(unit(np.cross(plane, up)) - PLANE_GAIN * np.dot(plane, up) * plane)
        d = math.cos(tilt) * up + math.sin(tilt) * horiz
        slv, vac, mdot = veh.burn(t)
        air = math.exp(-max(rn - R_EARTH, 0.0) / SCALE_H_KM)
        thrust = slv + (vac - slv) * (1 - air)
        vrel = v - np.cross(spin, r)
        sp = np.linalg.norm(vrel) + 1e-9
        drag = 0.5 * RHO0 * air * (sp * 1000) ** 2 * veh.cd * veh.area
        z = np.dot(r, pole) / rn
        a = -MU_EARTH * r / rn**3 + k_j2 / rn**5 * (
            r * (5 * z * z - 1) - 2 * rn * z * pole
        )
        a = a + (thrust * d - drag * vrel / sp) / m / 1000.0
        return np.concatenate([v, a, [-mdot]])

    edges = sorted(e for e in veh.edges() | {t_launch, t_end} if t_launch <= e <= t_end)
    y = np.concatenate([r0, v0, [veh.mass0]])
    ts, ys = [], []
    for a_, b_ in zip(edges[:-1], edges[1:]):
        for td, kg in veh.drops:
            if td == a_:
                y = y.copy()
                y[6] -= kg
        grid = np.arange(math.ceil(a_ / step) * step, b_, step)
        grid = np.unique(np.concatenate([[a_], grid, [b_]]))
        sol = solve_ivp(
            f, (a_, b_), y, method="DOP853", rtol=1e-8, atol=1e-8, t_eval=grid
        )
        ts.append(sol.t[:-1])
        ys.append(sol.y.T[:-1])
        y = sol.y[:, -1]
    ts.append(np.array([edges[-1]]))
    ys.append(y[None, :])
    return np.concatenate(ts), np.vstack(ys)
