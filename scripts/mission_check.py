"""Check a mission the 3D view plays (zimi/static/earth/missions-v1.json) against its source document (scripts/missions/<id>.json):
every event's place, height, speed, flight-path angle and heading, read off the shipped tables the way the player reads them,
against the document's value and tolerance. Used by tests/test_mission_events.py and by the fitter's own report.

    python3 scripts/mission_check.py apollo11        # one line per event, worst first

The shipped legs are Hermite tables of [t, x, y, z, vx, vy, vz] (km, km/s) in one of these frames:
  eci   the Earth's centre, ecliptic J2000 (a leg about the Moon too: its rows are geocentric);
  ecef  the turning Earth (WGS84 axes), velocity relative to it;
  mcmf  the turning Moon (mean Earth / polar axis, IAU 2009), velocity relative to it.
A Moon-fixed or selenographic answer needs the Moon's place: the mission's own ref.moon table (geocentric, ecliptic J2000).
"""

import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mission_physics import (  # noqa: E402
    F_EARTH,
    R_EARTH,
    R_MOON,
    ecef_to_ecl,
    ecef_to_geodetic,
    ecl_to_eq,
    moon_rotation,
)

MISSIONS_JSON = os.path.join(
    os.path.dirname(HERE), "zimi", "static", "earth", "missions-v1.json"
)
SOURCES_DIR = os.path.join(HERE, "missions")
NMI_KM = 1.852
FPS_KMS = 0.0003048
EARTH_RATE = 7.2921159e-5  # rad/s
MOON_RATE = 2 * math.pi / (27.321661 * 86400.0)
TDB_MINUS_UT_S = 40.2  # about 1969-2021 (IERS): the Moon's turn is in TDB
DEFAULT_TOL = {"deg": 0.5, "alt": 5.0, "v": 50.0, "fpa": 1.0, "heading": 1.0, "s": 0.0}


def load(mission_id, missions_json=MISSIONS_JSON):
    with open(missions_json) as fh:
        shipped = json.load(fh)["missions"].get(mission_id, {})   # a document of landing sites only has no mission of its own
    with open(os.path.join(SOURCES_DIR, mission_id + ".json")) as fh:
        source = json.load(fh)
    return shipped, source


def _bracket(rows, t):
    t = min(max(t, rows[0][0]), rows[-1][0])
    lo, hi = 0, len(rows) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if rows[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    return rows[lo], rows[hi], t


def hermite(rows, t):
    """Position and velocity from a table at t (held at its ends), as the player's _amTable reads it."""
    a, b, t = _bracket(rows, t)
    a, b = np.asarray(a[:7], float), np.asarray(b[:7], float)
    h = b[0] - a[0]
    if h <= 0:
        return a[1:4], a[4:7]
    u = (t - a[0]) / h
    u2, u3 = u * u, u**3
    p = (
        (2 * u3 - 3 * u2 + 1) * a[1:4]
        + (u3 - 2 * u2 + u) * h * a[4:7]
        + (-2 * u3 + 3 * u2) * b[1:4]
        + (u3 - u2) * h * b[4:7]
    )
    v = (
        (6 * u2 - 6 * u) * a[1:4]
        + (3 * u2 - 4 * u + 1) * h * a[4:7]
        + (-6 * u2 + 6 * u) * b[1:4]
        + (3 * u2 - 2 * u) * h * b[4:7]
    ) / h
    return p, v


def _leg_at(vehicle, t):
    """The leg that holds t: one that has begun and not ended (at a boundary, the one that begins there)."""
    legs = vehicle["legs"]
    for leg in legs:
        if leg["s"][0][0] <= t < leg["s"][-1][0]:
            return leg
    return legs[-1] if t >= legs[-1]["s"][0][0] else legs[0]


def _jd(zero_ms, t):
    return 2440587.5 + (zero_ms / 1000.0 + t) / 86400.0


def _moon_fixed(jd_ut):
    return moon_rotation(jd_ut + TDB_MINUS_UT_S / 86400.0) @ ecl_to_eq()


def state(shipped, vehicle_id, t, body):
    """The vehicle's place over `body` at t: dict(lat, lon, alt (nmi), v (ft/s, space-fixed), fpa, heading (deg))."""
    veh = [v for v in shipped["vehicles"] if v["id"] == vehicle_id][0]
    leg = _leg_at(veh, t)
    p, v = hermite(leg["s"], t)
    jd = _jd(shipped["zeroMs"], t)
    frame = leg["frame"]
    moon_p, moon_v = hermite(shipped["ref"]["moon"], t)
    if body == "earth":
        R = ecef_to_ecl(jd)
        if frame == "ecef":
            r_fix, v_rel = p, v
            v_in = R @ (v_rel + np.cross([0.0, 0.0, EARTH_RATE], r_fix))
            r_in = R @ r_fix
        elif frame == "eci":
            r_in, v_in = p, v
            r_fix = R.T @ r_in
        else:
            raise ValueError("an Earth event on a %s leg" % frame)
        lat, lon, alt = ecef_to_geodetic(r_fix)
    else:
        M = _moon_fixed(jd)
        if frame == "mcmf":
            r_fix = p
            v_in = M.T @ (v + np.cross([0.0, 0.0, MOON_RATE], p))
            r_in = M.T @ r_fix
        elif frame == "eci":
            r_in, v_in = p - moon_p, v - moon_v
            r_fix = M @ r_in
        else:
            raise ValueError("a Moon event on a %s leg" % frame)
        r = np.linalg.norm(r_fix)
        lat, lon, alt = (
            math.degrees(math.asin(r_fix[2] / r)),
            math.degrees(math.atan2(r_fix[1], r_fix[0])),
            r - R_MOON,
        )
    up = r_in / np.linalg.norm(r_in)
    speed = np.linalg.norm(v_in)
    fpa = (
        math.degrees(math.asin(max(-1.0, min(1.0, np.dot(v_in, up) / speed))))
        if speed > 0
        else 0.0
    )
    # North for the space-fixed heading is the Earth's mean pole at every body (MR table 7-I measures it in the Earth-centred
    # inertial frame: about the Moon the headings swing by the obliquity round the orbit), the Earth's turning pole being within a
    # few hundredths of a degree of it over a mission.
    pole = ecef_to_ecl(jd) @ np.array([0.0, 0.0, 1.0])
    north = pole - np.dot(pole, up) * up
    north /= np.linalg.norm(north)
    east = np.cross(north, up)
    vh = v_in - np.dot(v_in, up) * up
    heading = (
        math.degrees(math.atan2(np.dot(vh, east), np.dot(vh, north)))
        if np.linalg.norm(vh) > 0
        else 0.0
    )
    return dict(
        lat=lat, lon=lon, alt=alt / NMI_KM, v=speed / FPS_KMS, fpa=fpa, heading=heading
    )


def _angle(a, b):
    return (a - b + 180.0) % 360.0 - 180.0


# UTC leap seconds (IERS Bulletin C): the date each took effect, and TAI - UTC from then; TT = TAI + 32.184 s (TDB within 2 ms of it).
LEAP_SECONDS = [
    ("1972-01-01", 10), ("1972-07-01", 11), ("1973-01-01", 12), ("1974-01-01", 13), ("1975-01-01", 14), ("1976-01-01", 15),
    ("1977-01-01", 16), ("1978-01-01", 17), ("1979-01-01", 18), ("1980-01-01", 19), ("1981-07-01", 20), ("1982-07-01", 21),
    ("1983-07-01", 22), ("1985-07-01", 23), ("1988-01-01", 24), ("1990-01-01", 25), ("1991-01-01", 26), ("1992-07-01", 27),
    ("1993-07-01", 28), ("1994-07-01", 29), ("1996-01-01", 30), ("1997-07-01", 31), ("1999-01-01", 32), ("2006-01-01", 33),
    ("2009-01-01", 34), ("2012-07-01", 35), ("2015-07-01", 36), ("2017-01-01", 37),
]


def utc_s(ev):
    """An event's time as Unix seconds (UTC): t_utc as given, or t_tdb less TT - UTC."""
    from datetime import datetime, timezone

    if "t_utc" in ev:
        return datetime.fromisoformat(ev["t_utc"]).replace(tzinfo=timezone.utc).timestamp()
    t = datetime.fromisoformat(ev["t_tdb"]).replace(tzinfo=timezone.utc)
    tai_utc = [n for d, n in LEAP_SECONDS if t.strftime("%Y-%m-%d") >= d][-1]
    return t.timestamp() - 32.184 - tai_utc


def _shipped_event(shipped, ev):
    k = ev.get("shipped_k", "alm_ms_ev_flyby")
    hits = [e for e in shipped["events"] if e["k"] == k and (ev.get("planet") is None or e.get("planet") == ev["planet"])]
    return hits[0] if hits else None


def _check_timeline(shipped, ev, tol):
    """A time (and a flyby's distance) from the shipped timeline against the record."""
    miss = {}
    if ev["kind"] == "zero":
        miss["s"] = (abs(shipped["zeroMs"] / 1000.0 - utc_s(ev)), tol.get("s", 1.0))
        return {}, miss
    e = _shipped_event(shipped, ev)
    if e is None:
        return {}, {"missing": (1.0, 0.0)}
    miss["s"] = (abs(shipped["zeroMs"] / 1000.0 + e["t"] - utc_s(ev)), tol.get("s", 1.0))
    if "dist_km" in ev:
        miss["dist_km"] = (abs(e["dist"] - ev["dist_km"]), tol.get("dist_km", 0.01 * ev["dist_km"]))
    return e, miss


def _check_place_at_end(shipped, ev, tol):
    """Where a vehicle's last leg ends, on its body (a lander's pin)."""
    veh = [v for v in shipped["vehicles"] if v["id"] == ev["vehicle"]][0]
    p = np.asarray(veh["legs"][-1]["s"][-1][1:4], float)
    r = np.linalg.norm(p)
    lat, lon = math.degrees(math.asin(p[2] / r)), math.degrees(math.atan2(p[1], p[0]))
    return dict(lat=lat, lon=lon), {"deg": (math.hypot(lat - ev["lat"], _angle(lon, ev["lon"]) * math.cos(math.radians(ev["lat"]))), tol.get("deg", 0.01))}


PLANET_POLES = {"mars": "MARS_POLE"}
PLANET_R_KM = {"mars": 3396.2}   # the view's spheres (almanac-sites.js): an altitude is over this


def _check_fix(shipped, ev, tol):
    """Where a vehicle is on a planet at a time, as the player draws it: its Mars-fixed leg as it is, a planet-centred inertial leg
    turned by the planet's own frame."""
    import mission_physics

    veh = [v for v in shipped["vehicles"] if v["id"] == ev["vehicle"]][0]
    t = utc_s(ev) - shipped["zeroMs"] / 1000.0
    leg = _leg_at(veh, t)
    p, _ = hermite(leg["s"], t)
    p = np.asarray(p, float)
    if leg["frame"] == "rel":
        x, y, z = mission_physics.planet_frame(getattr(mission_physics, PLANET_POLES[ev["body"]]), _jd(shipped["zeroMs"], t))
        p = np.array([x @ p, y @ p, z @ p])
    r = np.linalg.norm(p)
    lat, lon, alt = math.degrees(math.asin(p[2] / r)), math.degrees(math.atan2(p[1], p[0])), r - PLANET_R_KM[ev["body"]]
    deg = math.hypot(lat - ev["lat"], _angle(lon, ev["lon"]) * math.cos(math.radians(ev["lat"])))
    return dict(lat=lat, lon=lon, alt_km=alt, leg=leg["frame"]), {"deg": (deg, tol.get("deg", 0.05)), "km": (abs(alt - ev["alt_km"]), tol.get("km", 3.0))}


SITES_JSON = os.path.join(os.path.dirname(MISSIONS_JSON), "sites-v1.json")


def _check_site_time(shipped, ev, tol):
    """A landing site's time in sites-v1.json (the instant the 3D view goes to for its landing) against the record."""
    with open(SITES_JSON) as fh:
        site = [s for s in json.load(fh)["sites"] if s["name"] == ev["site"]][0]
    got = site["ms"] / 1000.0
    return dict(utc=got), {"s": (abs(got - utc_s(ev)), tol.get("s", 1.0))}


def check(shipped, source):
    """Every event: (event, got, misses {field: (miss, tolerance)}, ok). An event marked `open` is a known gap, reported, not failed."""
    out = []
    for ev in source["events"]:
        if ev.get("kind") in ("zero", "time", "flyby", "place", "fix", "site_time"):
            fn = {"place": _check_place_at_end, "fix": _check_fix, "site_time": _check_site_time}.get(ev["kind"], _check_timeline)
            got, miss = fn(shipped, ev, ev.get("tol", {}))
            out.append((ev, got, miss, all(m <= t for m, t in miss.values())))
            continue
        tol = dict(
            DEFAULT_TOL,
            **source.get("tolerance", {}).get(ev.get("kind", ""), {}),
            **ev.get("tol", {}),
        )
        got = state(shipped, ev["vehicle"], ev["t"], ev["body"])
        miss = {}
        if "lat" in ev:
            km = (R_EARTH if ev["body"] == "earth" else R_MOON) * math.radians(1)
            ground = (
                math.hypot(
                    got["lat"] - ev["lat"],
                    _angle(got["lon"], ev["lon"]) * math.cos(math.radians(ev["lat"])),
                )
                * km
            )
            miss["ground_km"] = (ground, tol["deg"] * km)
        for k, f in (("alt", None), ("v", None), ("fpa", None), ("heading", _angle)):
            if k in ev and k in tol:
                d = f(got[k], ev[k]) if f else got[k] - ev[k]
                miss[k] = (
                    abs(d),
                    (
                        tol[k]
                        if k != "alt" or ev[k] < 1000
                        else max(tol[k], abs(ev[k]) * 0.01)
                    ),
                )
        ok = all(m <= t for m, t in miss.values())
        out.append((ev, got, miss, ok))
    return out


def report(mission_id):
    shipped, source = load(mission_id)
    rows = check(shipped, source)
    bad = 0
    for ev, got, miss, ok in rows:
        bad += not ok and not ev.get("open")
        print(
            "%-4s %-10s %s"
            % (
                "ok" if ok else "OPEN" if ev.get("open") else "MISS",
                ev["key"],
                "  ".join("%s %.2f/%.2f" % (k, m, t) for k, (m, t) in miss.items()),
            )
        )
    print("%d of %d events within tolerance" % (len(rows) - bad, len(rows)))
    return bad


if __name__ == "__main__":
    sys.exit(1 if report(sys.argv[1] if len(sys.argv) > 1 else "apollo11") else 0)
