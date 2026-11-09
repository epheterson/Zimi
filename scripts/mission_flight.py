"""Powered and coasting flight round the Earth and the Moon: one integrator with the Earth (J2), the Moon and the Sun, finite
burns steered relative to the velocity. Earth-centred, ecliptic J2000, km, km/s, s from the mission's zero.
"""

import math

import numpy as np
from scipy.integrate import solve_ivp

from mission_physics import G0, J2_EARTH, MU_EARTH, MU_MOON, MU_SUN, R_EARTH


class Burn:
    """A finite burn: thrust (N) and flow (kg/s) from t0 to t1, direction = the velocity (or against it, `sign` -1)
    turned by pitch (toward the radial, in the orbit plane) and yaw (out of it), each linear across the burn.
    """

    def __init__(
        self,
        t0,
        t1,
        thrust,
        mdot,
        sign=1,
        pitch=(0.0, 0.0),
        yaw=(0.0, 0.0),
        inertial=False,
    ):
        self.t0, self.t1, self.thrust, self.mdot, self.sign = t0, t1, thrust, mdot, sign
        self.pitch, self.yaw = pitch, yaw
        self.dir0 = None  # inertial=True: the direction at ignition, held

    def direction(self, t, r, v):
        tau = (t - self.t0) / (self.t1 - self.t0)
        a = self.pitch[0] + self.pitch[1] * tau
        b = self.yaw[0] + self.yaw[1] * tau
        vh = self.sign * v / np.linalg.norm(v)
        h = np.cross(r, v)
        h = h / np.linalg.norm(h)
        e = np.cross(h, vh)
        return (
            math.cos(a) * math.cos(b) * vh
            + math.sin(a) * math.cos(b) * e
            + math.sin(b) * h
        )


class Flight:
    def __init__(self, moon, sun, pole, use_sun=True):
        self.moon, self.sun, self.pole, self.use_sun = moon, sun, pole, use_sun
        self.k_j2 = 1.5 * J2_EARTH * MU_EARTH * R_EARTH**2

    def accel(self, t, r):
        rn = np.linalg.norm(r)
        a = -MU_EARTH * r / rn**3
        if rn < 120000:
            z = np.dot(r, self.pole) / rn
            a = a + self.k_j2 / rn**5 * (r * (5 * z * z - 1) - 2 * rn * z * self.pole)
        rm = self.moon.pos(t)
        d = rm - r
        a = a + MU_MOON * (d / np.linalg.norm(d) ** 3 - rm / np.linalg.norm(rm) ** 3)
        if self.use_sun:
            rs = self.sun.pos(t)
            d = rs - r
            a = a + MU_SUN * (d / np.linalg.norm(d) ** 3 - rs / np.linalg.norm(rs) ** 3)
        return a

    def run(self, y0, t0, t1, burns=(), step=None, rtol=1e-11, atol=1e-9):
        """y0 = [r, v, m]. Burns inside [t0, t1] are applied; returns (t, rows) at `step` seconds (or the solver's)."""
        burns = [b for b in burns if b.t1 > t0 and b.t0 < t1]
        edges = sorted(
            {t0, t1} | {max(t0, min(t1, x)) for b in burns for x in (b.t0, b.t1)}
        )
        y = np.array(y0, dtype=float)
        ts, ys = [], []

        def f(t, y):
            r, v, m = y[0:3], y[3:6], y[6]
            a = self.accel(t, r)
            mdot = 0.0
            for b in burns:
                if b.t0 <= t < b.t1:
                    a = a + b.thrust * b.direction(t, r, v) / m / 1000.0
                    mdot = b.mdot
                    break
            return np.concatenate([v, a, [-mdot]])

        for a_, b_ in zip(edges[:-1], edges[1:]):
            if b_ <= a_:
                continue
            grid = None
            if step:
                grid = np.unique(
                    np.concatenate(
                        [[a_], np.arange(math.ceil(a_ / step) * step, b_, step), [b_]]
                    )
                )
            sol = solve_ivp(
                f, (a_, b_), y, method="DOP853", rtol=rtol, atol=atol, t_eval=grid
            )
            ts.append(sol.t[:-1])
            ys.append(sol.y.T[:-1])
            y = sol.y[:, -1]
        ts.append(np.array([edges[-1]]))
        ys.append(y[None, :])
        return np.concatenate(ts), np.vstack(ys)


def impulse(y, dv_vec):
    y = np.array(y, dtype=float)
    y[3:6] = y[3:6] + dv_vec
    return y


def burn_mdot(thrust, isp):
    return thrust / (isp * G0)
