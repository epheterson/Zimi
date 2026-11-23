"""The probe missions of the player (Voyager 1 and 2, Cassini, New Horizons): flown on the probes' own JPL Horizons tables (space-tracks-v1.json), so what is
built here is the timeline: the flybys' dates and distances (closest approach found in Horizons' own vectors, probe against planet), phases and the camera.
"""

from datetime import datetime, timedelta, timezone

import numpy as np

import mission_physics as mp

EPOCH = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
HORIZONS_DAYS_TO_TDB = 0.0
PLANET_ID = {
    "Venus": "299",
    "Earth": "399",
    "Jupiter": "599",
    "Saturn": "699",
    "Uranus": "799",
    "Neptune": "899",
    "Pluto": "999",
}
PLANET_KM = {
    "Venus": 6051.8,
    "Earth": 6371.0,
    "Jupiter": 71492.0,
    "Saturn": 60268.0,
    "Uranus": 25559.0,
    "Neptune": 24764.0,
    "Pluto": 1188.3,
}


def when(jd_ut):
    return EPOCH + timedelta(days=jd_ut - 2451545.0)


def closest(probe, planet, date, half_days, step="10m"):
    """(time, centre distance km) of the closest approach of `probe` to `planet`, parabola through the three nearest vectors."""
    t0 = datetime.strptime(date, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    a = (t0 - timedelta(days=half_days)).strftime("%Y-%m-%d %H:%M")
    b = (t0 + timedelta(days=half_days)).strftime("%Y-%m-%d %H:%M")
    r = mp.horizons(probe, a, b, step, "500@" + PLANET_ID[planet])
    d = np.linalg.norm(r[:, 1:4], axis=1)
    i = int(np.clip(np.argmin(d), 1, len(d) - 2))
    y0, y1, y2 = d[i - 1], d[i], d[i + 1]
    dt = r[i + 1, 0] - r[i, 0]
    off = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if (y0 - 2 * y1 + y2) != 0 else 0.0
    jd = r[i, 0] + off * dt
    dmin = y1 - 0.25 * (y0 - y2) * off
    return jd, float(dmin)


# probe key (space-tracks-v1.json), Horizons id, launch (UTC), [(planet, approximate date, half window to search, days either side shown)]
SPECS = {
    "voyager1": dict(
        id="-31",
        launch="1977-09-05 12:56:00",
        flybys=[
            ("Jupiter", "1979-03-05 12:00", 2, 3),
            ("Saturn", "1980-11-12 23:46", 2, 3),
        ],
    ),
    "voyager2": dict(
        id="-32",
        launch="1977-08-20 14:29:44",
        flybys=[
            ("Jupiter", "1979-07-09 22:29", 2, 3),
            ("Saturn", "1981-08-26 03:24", 2, 3),
            ("Uranus", "1986-01-24 17:59", 2, 3),
            ("Neptune", "1989-08-25 03:56", 2, 3),
        ],
    ),
    "newhorizons": dict(
        id="-98",
        launch="2006-01-19 19:00:00",
        flybys=[
            ("Jupiter", "2007-02-28 05:42", 3, 4),
            ("Pluto", "2015-07-14 11:50", 2, 3),
        ],
    ),
    "cassini": dict(
        id="-82",
        launch="1997-10-15 08:43:00",
        flybys=[
            ("Venus", "1999-06-24 20:30", 2, 3),
            ("Earth", "1999-08-18 03:28", 2, 3),
        ],
    ),
}


def flyby_table(key):
    spec = SPECS[key]
    rows = []
    for planet, date, half, shown in spec["flybys"]:
        jd, d = closest(spec["id"], planet, date, half)
        rows.append(
            dict(
                planet=planet,
                jd=jd,
                dist_km=d,
                altitude_km=d - PLANET_KM[planet],
                shown_days=shown,
            )
        )
    return rows


if __name__ == "__main__":
    for k in SPECS:
        for r in flyby_table(k):
            print(
                k,
                r["planet"],
                when(r["jd"]).strftime("%Y-%m-%d %H:%M"),
                "%.0f km from the centre, %.0f km up"
                % (r["dist_km"], r["altitude_km"]),
            )
