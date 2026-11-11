"""Perseverance's last day at Mars (slice 1): the approach from JPL Horizons' own table of the spacecraft (Mars-centred), then the entry, descent and landing as a
profile through the published events, flown over the Mars-fixed ground the view already uses (its Mars rotation, never a second one), ending at the Perseverance pin
in landmarks-v1.json (Jezero, 18.4446 N 77.4509 E).

It follows the landing's published events; it is not a simulated guidance law. Assumed, and said so in the reference: the entry heading (ENE) and the altitude and
speed between the events.
"""

import math
from datetime import datetime, timezone

import numpy as np

from mission_physics import horizons
from mission_tables import pack, thin

R_MARS_KM = 3396.2  # the view's Mars (equatorial); a site stands on this sphere (almanac-sites.js)
JEZERO = (18.4446, 77.4509)  # landmarks-v1.json, the Perseverance pin
LAUNCH = datetime(
    2020, 7, 30, 11, 50, 0, tzinfo=timezone.utc
)  # Atlas V 541, Cape Canaveral
TOUCHDOWN = datetime(
    2021, 2, 18, 20, 55, 0, tzinfo=timezone.utc
)  # sites-v1.json: the landing's own time
ENTRY_HEADING_DEG = 62.0  # assumed: the entry flew east-north-east to Jezero

# Seconds after the entry interface: altitude (km above the sphere) and speed relative to the ground (m/s). The events are the press kit's (entry at about 132 km and
# 5.4 km/s, parachute at about 11 km and Mach 1.7, heat shield off about 20 s later, powered descent from about 2 km, rover on the bridles at 20 m, 0.75 m/s at touchdown);
# the numbers between them are interpolated.
PROFILE = [
    (0.0, 132.0, 5400.0),
    (70.0, 70.0, 5000.0),
    (100.0, 45.0, 4300.0),
    (130.0, 30.0, 3000.0),
    (160.0, 22.0, 1900.0),
    (215.0, 14.0, 700.0),
    (240.0, 11.0, 430.0),
    (262.0, 8.5, 100.0),
    (330.0, 2.1, 85.0),
    (380.0, 0.9, 35.0),
    (405.0, 0.02, 0.75),
    (412.0, 0.0, 0.75),
]
T_TOUCH = PROFILE[-1][0]
# where the six wheels stand under the body (sites-v1.json, the rover's own table), deployed as they are on the bridles
ROVER_WHEELS = [[-1.062, 1.277, 0.263], [1.062, 1.277, 0.263], [-1.184, 0.092, 0.263], [1.184, 0.092, 0.263], [1.062, -0.983, 0.263], [-1.062, -0.983, 0.263]]
EVENT_AFTER_EI = {
    "chute": 240.0,
    "hs_sep": 262.0,
    "bs_sep": 330.0,
    "skycrane": 405.0,
    "touch": T_TOUCH,
    "peak_heat": 100.0,
    "peak_g": 130.0,
}
CRUISE_SEP_BEFORE_EI = 600.0


def seconds(dt):
    return (dt - LAUNCH).total_seconds()


def jd_unix(dt):
    return dt.timestamp() / 86400.0 + 2440587.5


def zero_ms():
    return int(LAUNCH.timestamp() * 1000)


def to_xyz(lat, lon, alt_km):
    r = R_MARS_KM + alt_km
    la, lo = math.radians(lat), math.radians(lon)
    return np.array(
        [
            r * math.cos(la) * math.cos(lo),
            r * math.cos(la) * math.sin(lo),
            r * math.sin(la),
        ]
    )


def from_xyz(p):
    r = float(np.linalg.norm(p))
    return (
        math.degrees(math.asin(p[2] / r)),
        math.degrees(math.atan2(p[1], p[0])),
        r - R_MARS_KM,
    )


def move(lat, lon, bearing_deg, arc_rad):
    """The point arc_rad along the great circle from (lat, lon) on a bearing (degrees from north, east positive)."""
    la, lo, b = math.radians(lat), math.radians(lon), math.radians(bearing_deg)
    la2 = math.asin(
        math.sin(la) * math.cos(arc_rad)
        + math.cos(la) * math.sin(arc_rad) * math.cos(b)
    )
    lo2 = lo + math.atan2(
        math.sin(b) * math.sin(arc_rad) * math.cos(la),
        math.cos(arc_rad) - math.sin(la) * math.sin(la2),
    )
    return math.degrees(la2), ((math.degrees(lo2) + 540.0) % 360.0) - 180.0


def profile_at(t):
    ts = [p[0] for p in PROFILE]
    from scipy.interpolate import PchipInterpolator

    return float(PchipInterpolator(ts, [p[1] for p in PROFILE])(t)), float(
        PchipInterpolator(ts, [p[2] for p in PROFILE])(t)
    )


def track(step=1.0):
    """Rows [t after EI, lat, lon, alt_km, v_m_s] from the entry interface to touchdown, ending at the pin."""
    ts = np.arange(0.0, T_TOUCH + 1e-9, step)
    alt = np.array([profile_at(t)[0] for t in ts])
    spd = np.array([profile_at(t)[1] for t in ts])
    vz = np.gradient(alt * 1000.0, ts)
    vh = np.sqrt(np.maximum(spd**2 - vz**2, 0.0))
    arc = np.concatenate(
        [
            [0.0],
            np.cumsum(
                0.5
                * (vh[1:] + vh[:-1])
                * np.diff(ts)
                / ((R_MARS_KM * 1000.0) + 0.5 * (alt[1:] + alt[:-1]) * 1000.0)
            ),
        ]
    )
    total = arc[-1]
    back = (ENTRY_HEADING_DEG + 180.0) % 360.0
    lat0, lon0 = move(JEZERO[0], JEZERO[1], back, total)
    # the way from there to the pin is one great circle (its bearing turns a little on the way), flown by the distance covered
    u0, u1 = to_xyz(lat0, lon0, 0.0), to_xyz(JEZERO[0], JEZERO[1], 0.0)
    u0, u1 = u0 / np.linalg.norm(u0), u1 / np.linalg.norm(u1)
    ang = math.acos(float(np.clip(np.dot(u0, u1), -1.0, 1.0)))
    rows = []
    for t, a, s_, ar in zip(ts, alt, spd, arc):
        f = ar / total
        w = (math.sin((1 - f) * ang) * u0 + math.sin(f * ang) * u1) / math.sin(ang)
        rows.append([t, math.degrees(math.asin(w[2])), math.degrees(math.atan2(w[1], w[0])), a, s_])
    rows = np.array(rows)
    return np.array(rows), total * R_MARS_KM


def fixed_rows(trk, t_ei):
    """Mars-fixed rows [t from launch, x, y, z (km), vx, vy, vz (km/s)] from the track, velocities by difference."""
    p = np.array([to_xyz(r[1], r[2], r[3]) for r in trk])
    t = trk[:, 0] + t_ei
    v = np.gradient(p, t, axis=0)
    return np.hstack([t[:, None], p, v])


def approach_rows(t_end):
    """Horizons' Mars-centred table of the spacecraft (ecliptic J2000), 15:00 to t_end on 2021-02-18, as [t from launch, x, y, z, vx, vy, vz]."""
    a = horizons(
        "-168", "2021-02-18 15:00", "2021-02-18 21:00", "30m", center="500@499"
    )
    b = horizons("-168", "2021-02-18 20:00", "2021-02-18 21:00", "1m", center="500@499")
    rows = [
        r
        for r in a
        if jd_unix(datetime(2021, 2, 18, 15, tzinfo=timezone.utc)) - 1e-9
        <= r[0]
        < jd_unix(datetime(2021, 2, 18, 20, tzinfo=timezone.utc))
    ]
    rows += [
        r
        for r in b
        if r[0] <= jd_unix(LAUNCH + (TOUCHDOWN - LAUNCH))
        and seconds(
            datetime.fromtimestamp((r[0] - 2440587.5) * 86400.0, tz=timezone.utc)
        )
        <= t_end
    ]
    out = []
    for r in rows:
        t = (r[0] - jd_unix(LAUNCH)) * 86400.0
        if t <= t_end:
            out.append([t] + list(r[1:7]))
    return np.array(out)



def _fall(fx, t0, span, drift=0.0, accel=0.0, vz=0.0):
    """Rows of a piece that lets go at t0: from the capsule's place, drifting along the ground at `drift` km/s and falling: a constant `vz` km/s down and `accel` km/s^2 more."""
    k = int(np.argmin(abs(fx[:, 0] - t0)))
    p0, v0 = fx[k, 1:4], fx[k, 4:7]
    up = p0 / np.linalg.norm(p0)
    vel_h = v0 - up * float(np.dot(v0, up))
    h = vel_h / max(float(np.linalg.norm(vel_h)), 1e-9)
    out = []
    for dt in np.arange(0.0, span + 1e-9, 1.0):
        pos = p0 + v0 * dt - up * (vz * dt + 0.5 * accel * dt * dt) + h * drift * dt
        vel = v0 - up * (vz + accel * dt) + h * drift
        out.append(np.concatenate([[t0 + dt], pos, vel]))
    return np.array(out)


def phases_and_events(t_ei, t_start, extra):
    K = "alm_ms_"

    def ph(t, key, en, w, rate, follow, cam, **kw):
        d = {
            "t": round(t, 1),
            "k": K + "ph_" + key,
            "en": en,
            "w": w,
            "rate": rate,
            "follow": follow,
            "cam": cam,
            "ref": "mars",
        }
        d.update(kw)
        return d

    def ev(t, key, en, icon="dot"):
        return {"t": round(float(t), 1), "k": K + "ev_" + key, "en": en, "icon": icon}

    e = lambda name: t_ei + EVENT_AFTER_EI[name]
    t_sep = t_ei - CRUISE_SEP_BEFORE_EI
    ml, tb, sc = extra["ml"], extra["burn"], extra["sc"]
    EVL = ml.EV
    launch_ph = [
        ph(-10.0, "launch", "Launch", 1.0, 1, "m20", {"d": 170, "az": 100, "el": 6, "look": [0, -26, 0]}, far=False),
        ph(60.0, "ascent", "Ascent", 1.0, 1, "m20", {"d": 150, "az": 100, "el": 6, "look": [0, -20, 0]}, far=False),
        ph(EVL["orbit"], "park", "Parking orbit", 0.8, 60, "m20", {"d": 60, "az": 100, "el": 10, "look": [0, -12, 0]}, far=False),
        ph(tb - 90.0, "tmi", "Mars injection", 0.9, 4, "m20", {"d": 55, "az": 100, "el": 10, "look": [0, -12, 0]}, far=False),
        ph(sc + 120.0, "cruise", "Cruise", 3.0, 200000, "m20", {"overview": True, "fit": True}, ref="sun", far=False),
    ]
    launch_ev = [
        ev(0.0, "liftoff", "Liftoff", "burn"),
        ev(EVL["srb_sep"], "srb_sep", "Booster separation", "split"),
        ev(EVL["fairing"], "fairing_sep", "Fairing jettison", "split"),
        ev(EVL["meco"], "meco", "Main engine cutoff", "split"),
        ev(EVL["centaur1"], "centaur_burn", "Centaur burn", "burn"),
        ev(EVL["orbit"], "orbit", "In orbit", "dot"),
        ev(tb, "tmi_burn", "Mars injection burn", "burn"),
        ev(sc, "sc_sep", "Spacecraft separation", "split"),
    ]
    far_ph = [
        ph(
            t_sep - 5400,
            "approach",
            "Approach",
            1.0,
            120,
            "m20",
            {"body": "mars", "d": 2.5e7, "az": 0.5, "el": 0.3, "mix": 0.5},
            far=False,
            planet="Mars",
        ),
        ph(
            t_sep - 90,
            "separation",
            "Cruise stage separation",
            0.8,
            6,
            "m20",
            {"d": 22, "az": 100, "el": 10, "look": [0, 1.5, 0]},
            far=False,
        ),
        ph(
            t_ei - 30,
            "entry",
            "Entry",
            1.0,
            3,
            "m20",
            {"d": 14, "az": 100, "el": 8, "look": [0, 1.2, 0]},
            far=False,
        ),
        ph(
            e("chute") - 8,
            "chutes",
            "Parachute",
            0.9,
            3,
            "m20",
            {"d": 90, "az": 100, "el": 6, "look": [0, 26, 0]},
            far=False,
        ),
        ph(
            e("bs_sep") - 12,
            "descent",
            "Powered descent",
            1.0,
            3,
            "sky",
            {"d": 16, "az": 90, "el": 4, "look": [0, 0, 4]},
            far=False,
        ),
        ph(
            e("touch") - 4,
            "touchdown",
            "Touchdown",
            0.5,
            1,
            "sky",
            {"d": 12, "az": 70, "el": 6, "look": [0, 0, 2]},
            far=False,
        ),
    ]
    evs = [
        ev(t_sep, "cruise_sep", "Cruise stage separation", "split"),
        ev(t_ei, "m20_entry", "Entry interface", "dot"),
        ev(e("peak_heat"), "peak_heat", "Peak heating", "burn"),
        ev(e("chute"), "chute", "Parachute deployed", "dot"),
        ev(e("hs_sep"), "hs_sep", "Heat shield separation", "split"),
        ev(e("bs_sep"), "bs_sep", "Backshell separation", "split"),
        ev(e("skycrane"), "skycrane", "Sky crane", "burn"),
        ev(e("touch"), "m20_touchdown", "Touchdown", "dot"),
    ]
    return launch_ph + far_ph, launch_ev + evs


def launch_parts(ml, t_sc):
    """The Atlas V 541 around the payload: its parts at their places below the payload's base (the vehicle's origin), and the payload itself flipped, heat shield up."""
    p = lambda m, at, **kw: dict({"m": m, "at": at}, **kw)
    ev = ml.EV
    H = ml.STACK_H
    out = [
        p("ms-atlas-core", [0.0, -H, 0.0], to=ev["meco"] + 5.0),
        p("ms-atlas-centaur", [0.0, -H + 34.0, 0.0], to=t_sc),
        p("ms-atlas-fairing", [0.0, -H + 32.5, 0.0], to=ev["fairing"]),
        p("ms-m20-heatshield", [0.0, 3.9, 0.0], rx=180, to=t_sc),
        p("ms-m20-backshell", [0.0, 3.9 - 0.9, 0.0], rx=180, to=t_sc),
        p("ms-m20-cruise", [0.0, 0.0, 0.0], rx=180, to=t_sc),
    ]
    for a in (45, 135, 225, 315):
        out.append(p("ms-atlas-srb", [2.65 * math.cos(math.radians(a)), -H + 0.0, 2.65 * math.sin(math.radians(a))], to=ev["srb_sep"]))
    return out


def launch_flames(ml, t_burn, t_sc):
    ev = ml.EV
    H = ml.STACK_H
    fl = [
        {"from": -6.0, "to": ev["meco"], "at": [0, -H - 2.4, 0], "len": 34.0, "r": 3.0, "vac": 2.0, "vacAlt": 100},
        {"from": ev["centaur1"], "to": ev["orbit"], "at": [0, -H + 34.0 - 2.2, 0], "len": 9.0, "r": 0.9, "vac": 0.0, "vacAlt": 100},
        {"from": t_burn, "to": t_burn + 520.0, "at": [0, -H + 34.0 - 2.2, 0], "len": 9.0, "r": 0.9, "vac": 0.0, "vacAlt": 100},
    ]
    for a in (45, 135, 225, 315):
        fl.append({"from": -6.0, "to": ml.EV["srb_sep"] - 12.0, "at": [2.65 * math.cos(math.radians(a)), -H - 1.2, 2.65 * math.sin(math.radians(a))], "len": 20.0, "r": 1.0, "vac": 1.0, "vacAlt": 100})
    return fl


def build():
    import mission_perseverance_launch as ml

    launch_leg, inert_leg, helio_leg, moon_rows, t_burn, sun_rows = ml.build()
    t_sc = ml.EV["sc_sep"]
    t_touch = seconds(TOUCHDOWN)
    t_ei = t_touch - T_TOUCH
    t_sep = t_ei - CRUISE_SEP_BEFORE_EI
    trk, range_km = track()
    fx = fixed_rows(trk, t_ei)
    app = approach_rows(t_sep)
    print(
        "perseverance: entry range %.0f km, approach rows %d, EI at T+%.0f s"
        % (range_km, len(app), t_ei)
    )
    app_thin = thin(app[:, :7], 5.0, 1800.0)
    approach_leg = {
        "frame": "rel",
        "body": "mars",
        "ref": "mars",
        "s": pack(app_thin, 3, 6),
    }

    def fixed_leg(rows, att="retro", sd=900):
        return {
            "frame": "mfix",
            "body": "mars",
            "ref": "mars",
            "att": att,
            "s": pack(thin(rows, 0.002, 20.0), 4, 6),
            "sd": sd,
        }

    terminal = fixed_leg(fx)
    part = lambda m, y=0.0, **kw: dict({"m": m, "at": [0.0, y, 0.0]}, **kw)
    t_hs = t_ei + EVENT_AFTER_EI["hs_sep"]
    t_bs = t_ei + EVENT_AFTER_EI["bs_sep"]
    t_ch = t_ei + EVENT_AFTER_EI["chute"]
    m20 = {
        "id": "m20",
        "on": -10.0,
        "off": t_bs + 1.0,
        "dot": True,
        "legs": [launch_leg, inert_leg, helio_leg, approach_leg, terminal],
        "parts": [
            part("ms-m20-heatshield", 0.0, **{"from": t_sc, "to": t_hs}),
            part("ms-m20-backshell", 0.9, **{"from": t_sc, "to": t_bs}),
            part("ms-m20-cruise", 3.4, **{"from": t_sc, "to": t_sep}),
            part("ms-m20-parachute", 3.4, **{"from": t_ch, "to": t_bs}),
        ] + launch_parts(ml, t_sc),
        "flames": launch_flames(ml, t_burn, t_sc) + [
            {
                "from": t_ei + 20.0,
                "to": t_ei + 150.0,
                "at": [0, -1.0, 0],
                "len": 14.0,
                "r": 2.6,
                "rx": 0,
            }
        ],
    }
    # the cruise stage keeps its course a while after it lets go
    cruise = {"id": "cruise", "on": t_sep, "off": t_ei + 5.0, "dot": False, "legs": [dict(approach_leg, s=pack(app_thin[app_thin[:, 0] >= t_sep - 60.0], 3, 6))],
              "parts": [part("ms-m20-cruise", 0.0)], "flames": []}
    # after the backshell lets go the descent stage carries the rover down on its own engines
    after = fx[fx[:, 0] >= t_bs - 1.0]
    sky = {"id": "sky", "on": t_bs, "off": fx[-1, 0] + 600.0, "dot": False, "legs": [dict(fixed_leg(after, att="level", sd=1), ref="mars")],
           "parts": [dict(part("ms-m20-descent", 0.0, rx=90), at=[0.0, 0.0, 7.5], **{"to": fx[-1, 0] - 1.0}), part("site-perseverance-body", 0.0)] + [{"m": "site-perseverance-wheel", "at": w} for w in ROVER_WHEELS],
           "flames": [{"from": t_bs + 4.0, "to": fx[-1, 0] - 1.0, "at": [0, 0, 6.2], "len": 6.0, "r": 0.7, "rx": 90}]}
    # the heat shield and the backshell fall away from where they let go
    hs = {"id": "hs", "on": t_hs, "off": t_hs + 45.0, "dot": False, "legs": [fixed_leg(_fall(fx, t_hs, 45.0, drift=0.0, accel=0.004), att="level", sd=1)],
          "parts": [part("ms-m20-heatshield", 0.0, rx=90)], "flames": []}
    bs = {"id": "bs", "on": t_bs, "off": t_bs + 70.0, "dot": False, "legs": [fixed_leg(_fall(fx, t_bs, 70.0, drift=0.012, accel=0.0, vz=0.045), att="level", sd=1)],
          "parts": [part("ms-m20-backshell", 0.0, rx=90), part("ms-m20-parachute", 2.5, rx=90)], "flames": []}
    return t_ei, trk, fx, [m20, cruise, sky, hs, bs], terminal, dict(moon=moon_rows, burn=t_burn, sc=t_sc, ml=ml, approach_start=float(app[0, 0]))


if __name__ == "__main__":
    t_ei, trk, fx, V, term, extra = build()
    print("touch", trk[-1], "EI", trk[0])
