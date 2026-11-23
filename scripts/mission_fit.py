"""The missions' one fitter: a flight as a chain of phases between the source document's events (scripts/missions/<id>.json),
each phase starting from the end state of the one before.

A source event that gives a full state (place, height, space-fixed speed, flight-path angle and heading) is an anchor: report_state()
turns it into the integrator's vector (km, km/s, Earth-centred ecliptic J2000). Between anchors a phase is one of:
  coast       no thrust (the Earth with J2, the Moon and the Sun: mission_flight.Flight)
  burn        a finite burn of known length and engine, its thrust scale, pitch and yaw (each at its start and end) solved
              so the burn's end meets the next anchor
  impulse     a small velocity change at an event's time, solved so a later anchor is met (a midcourse correction)
The phases that are their own physics (a launch, a powered descent, a lunar ascent, an entry) are the mission's own modules;
they hand back an end state like any other phase. mission_check.py measures the result against the same document.
"""

import math

import numpy as np
from scipy.optimize import least_squares

from mission_flight import Burn
from mission_physics import R_EARTH, R_MOON, ecef_to_ecl, ecl_to_eq, moon_rotation

NMI_KM = 1.852
FPS_KMS = 0.0003048
EARTH_RATE = 7.2921159e-5
TDB_MINUS_UT_S = 40.2


def _geodetic_to_ecef(lat, lon, alt_km):
    from mission_physics import geodetic_to_ecef

    return geodetic_to_ecef(lat, lon, alt_km)


def report_state(ev, zero_jd, moon=None):
    """A source event's state as [r, v] (km, km/s), Earth-centred ecliptic J2000. The heading is measured from the Earth's
    pole at every body (MR table 7-I: space-fixed angles in the Earth-centred inertial frame); a Moon event needs `moon`, an
    Ephemeris of the Moon's geocentric place."""
    t = ev["t"]
    jd = zero_jd + t / 86400.0
    alt = ev["alt"] * NMI_KM
    if ev["body"] == "earth":
        R = ecef_to_ecl(jd)
        r = R @ _geodetic_to_ecef(ev["lat"], ev["lon"], alt)
        centre_p, centre_v = np.zeros(3), np.zeros(3)
    else:
        M = moon_rotation(jd + TDB_MINUS_UT_S / 86400.0) @ ecl_to_eq()
        la, lo = math.radians(ev["lat"]), math.radians(ev["lon"])
        rr = R_MOON + alt
        r = M.T @ (
            rr
            * np.array(
                [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)]
            )
        )
        centre_p, centre_v = moon.state(t)
    up = r / np.linalg.norm(r)
    pole = ecef_to_ecl(jd) @ np.array([0.0, 0.0, 1.0])
    north = pole - np.dot(pole, up) * up
    north /= np.linalg.norm(north)
    east = np.cross(north, up)
    g, h = math.radians(ev["fpa"]), math.radians(ev["heading"])
    v = (
        ev["v"]
        * FPS_KMS
        * (math.sin(g) * up + math.cos(g) * (math.cos(h) * north + math.sin(h) * east))
    )
    return np.concatenate([r + centre_p, v + centre_v])


def miss(y, target, moon=None, t=None, w_pos=1.0, w_vel=1000.0):
    """The gap between a state and an anchor, as one vector: km of position and (scaled) km/s of velocity. About the Moon both
    are taken relative to it (the anchor already is geocentric)."""
    return np.concatenate(
        [(y[0:3] - target[0:3]) * w_pos, (y[3:6] - target[3:6]) * w_vel]
    )


def vel_frame(r, v):
    p = v / np.linalg.norm(v)
    h = np.cross(r, v)
    h /= np.linalg.norm(h)
    return p, np.cross(h, p), h


def fit_burn(
    fl,
    y0,
    t0,
    t1,
    thrust,
    mdot,
    sign,
    target,
    rel=None,
    x0=(1.0, 0.0, 0.0, 0.0, 0.0),
    w_vel=1000.0,
    max_nfev=80,
    extra=None,
):
    """A finite burn from y0 (t0 to t1), solved so its end state meets `target` (position and velocity). x = thrust scale, pitch
    at start and its change, yaw at start and its change (radians). Returns (Burn, x, end state, residual).
    """

    def burn(x):
        return Burn(
            t0,
            t1,
            thrust * x[0],
            mdot,
            sign=sign,
            pitch=(x[1], x[2]),
            yaw=(x[3], x[4]),
            rel=rel,
        )

    def resid(x):
        _, Y = fl.run(y0, t0, t1, (burn(x),), step=None)
        r = list(miss(Y[-1], target, w_vel=w_vel))
        if extra:
            r += list(extra(x))
        return r

    s = least_squares(
        resid,
        list(x0),
        diff_step=1e-5,
        x_scale=[0.01, 0.01, 0.01, 0.01, 0.01],
        max_nfev=max_nfev,
        bounds=([0.8, -0.6, -0.6, -0.6, -0.6], [1.2, 0.6, 0.6, 0.6, 0.6]),   # the engine within a fifth of its book thrust, steering within 35 degrees
    )
    b = burn(s.x)
    _, Y = fl.run(y0, t0, t1, (b,), step=None)
    return b, s.x, Y[-1], np.array(s.fun)


def fit_impulse(
    fl,
    y0,
    t0,
    t_target,
    target,
    components=6,
    w_vel=1000.0,
    x0=(0.0, 0.0, 0.0),
    max_nfev=60,
):
    """A velocity change at t0 (prograde, radial, normal; km/s) so that the coast meets `target` at t_target: its position
    (components 3) or its position and velocity (6, least squares). Returns (dv, state after, residual).
    """
    p, rad, nrm = vel_frame(y0[0:3], y0[3:6])

    def after(dv):
        y = np.array(y0, float)
        y[3:6] = y[3:6] + dv[0] * p + dv[1] * rad + dv[2] * nrm
        return y

    def resid(dv):
        _, Y = fl.run(after(dv), t0, t_target, (), step=None)
        m = miss(Y[-1], target, w_vel=w_vel)
        return m[:components]

    s = least_squares(
        resid, list(x0), diff_step=1e-6, x_scale=[1e-3] * 3, max_nfev=max_nfev
    )
    return s.x, after(s.x), np.array(s.fun)


def coast_to(fl, y0, t0, t1, anchor=None, step=30.0):
    """A coast from y0 (t0 to t1) as rows (t, Y). With `anchor` (the state the source document gives at t1) the path is the
    forward coast from y0 blended into the backward coast from the anchor, smoothly in time (a smoothstep), so the chain is
    continuous at both ends and lands on the document's state; each half is the force model's own path, and the blend moves
    the drawn path by the gap between them (mission_check reports each gap) spread over the whole coast."""
    tf, Yf = fl.run(y0, t0, t1, (), step=step)
    if anchor is None:
        return tf, Yf
    ya = np.array(Yf[-1], float)
    ya[0:6] = anchor[0:6]
    tb, Yb = fl.run(ya, t1, t0, (), step=step)
    Yb = _resample(tb[::-1], Yb[::-1], tf)
    u = (tf - t0) / (t1 - t0)
    w = u * u * (3 - 2 * u)
    dw = 6 * u * (1 - u) / (t1 - t0)
    Y = np.array(Yf, float)
    Y[:, 0:3] = (1 - w)[:, None] * Yf[:, 0:3] + w[:, None] * Yb[:, 0:3]
    Y[:, 3:6] = (1 - w)[:, None] * Yf[:, 3:6] + w[:, None] * Yb[:, 3:6] + dw[:, None] * (Yb[:, 0:3] - Yf[:, 0:3])
    return tf, Y


def gap(y, anchor):
    """(km, m/s) between a state and an anchor."""
    return float(np.linalg.norm(y[0:3] - anchor[0:3])), float(1000 * np.linalg.norm(y[3:6] - anchor[3:6]))


def _resample(t, Y, at):
    """Rows Y at times t (increasing) re-read at the times `at` by cubic Hermite through positions and velocities (mass linear)."""
    out = np.empty((len(at), Y.shape[1]))
    j = 0
    for i, x in enumerate(at):
        while j < len(t) - 2 and t[j + 1] < x:
            j += 1
        a, b = Y[j], Y[j + 1]
        h = t[j + 1] - t[j]
        u = 0.0 if h <= 0 else min(1.0, max(0.0, (x - t[j]) / h))
        u2, u3 = u * u, u ** 3
        out[i, 0:3] = (2 * u3 - 3 * u2 + 1) * a[0:3] + (u3 - 2 * u2 + u) * h * a[3:6] + (-2 * u3 + 3 * u2) * b[0:3] + (u3 - u2) * h * b[3:6]
        out[i, 3:6] = ((6 * u2 - 6 * u) * a[0:3] + (3 * u2 - 4 * u + 1) * h * a[3:6] + (-6 * u2 + 6 * u) * b[0:3] + (3 * u2 - 2 * u) * h * b[3:6]) / h if h > 0 else a[3:6]
        out[i, 6:] = a[6:] + (b[6:] - a[6:]) * u
    return out


def ground_fractions(ts, speed, alt, ang, radius, window=None):
    """An entry flown as a speed and height profile over one great circle `ang` radians long: the share of that circle covered at each
    time. The profile's speeds are raised or lowered inside `window` (t from, t to; the whole profile by default) by a sin^2 bump that
    is nothing at either end, so the record's speeds outside it stand, until the ground they cover at their own radius is the circle's.
    Returns (fractions, the bump's scale)."""
    from scipy.optimize import brentq

    ts, speed, alt = (np.asarray(x, float) for x in (ts, speed, alt))
    a, b = window or (ts[0], ts[-1])
    inside = (ts >= a) & (ts <= b)
    climb = np.gradient(alt, ts)
    bump = np.where(inside, speed * np.sin(math.pi * np.clip((ts - a) / (b - a), 0.0, 1.0)) ** 2, 0.0)

    def turned(k):
        v = speed + k * bump
        rate = np.sqrt(np.maximum(v * v - climb * climb, 0.0)) / (radius + alt)
        return np.concatenate([[0.0], np.cumsum(0.5 * (rate[1:] + rate[:-1]) * np.diff(ts))])

    k = brentq(lambda kk: turned(kk)[-1] - ang, -0.95, 5.0)
    return turned(k) / ang, k
