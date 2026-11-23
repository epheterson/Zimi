"""Write the six Apollo landing sites of zimi/static/earth/sites-v1.json: what stands where, from published positions.

    python scripts/build_apollo_sites.py

Every part is a row {m, x, y, h, from, until, src, err, ll}: its model, its place in metres east (x) and north (y) of the
descent stage, the compass bearing of the model's front (h), the instants it stands between, a source key (SOURCES) and
the error of the place in metres. A part measured as a latitude and longitude (ll) is turned into x and y here, so the
two can be checked against each other (tests/test_almanac_sites.py).

Positions, in the order of trust:
  1. LROC: Wagner et al. 2017 (Icarus 283, 92), the Arizona State University / PDS shapefile of anthropogenic
     objects: the descent stages, the ALSEP central stations, the seismometers, the final parking place of each rover,
     and (laser ranging) the retroreflectors of Apollo 11, 14 and 15.
  2. The Apollo Lunar Surface Journal (ALSJ): Apollo 11 photogrammetry (Pustynski and Jones), the Apollo 15 flag page.
  3. The site maps: USGS 1978 Apollo 11 map (1:250), the Apollo 15, 16 and 17 Preliminary Science Reports' planimetric
     maps, and the ALSJ's planimetric maps on LROC images of Apollo 12 and 14 (positions read off their 10 m grids).
Where two disagree the LROC one is used. A place read off a map carries its error in `err`; nothing is placed without a source.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_site_models as bsm  # noqa: E402

MOON_R_M = 1737400.0
M_PER_DEG = MOON_R_M * math.pi / 180

SOURCES = {
    "lroc": "LROC NAC positions: Wagner et al. 2017, Icarus 283, 92 (ASU/PDS anthropogenic objects)",
    "lroc-laser": "Retroreflector position from laser ranging: Wagner et al. 2017 (ASU/PDS anthropogenic objects)",
    "a11-phot": "ALSJ Apollo 11 Photogrammetry (Pustynski and Jones): flag 10.7 m from the LM centre, 7.8 m from the +Y pad; LM landed 13.3 degrees counterclockwise from east-west; flag points 24 degrees south of east",
    "a11-map": "USGS 1978 Apollo 11 site map, scale 1:250 (positions measured off it)",
    "a11-liftoff": "Aldrin, ALSJ: the flag was blown over by the ascent engine; the direction it fell is not published",
    "a12-map": "ALSJ Apollo 12 EVA-1 planimetric map on LROC M175428601R, 10 m grid (positions measured off it)",
    "a12-psr": "Apollo 12 Preliminary Science Report: the LM landed rotated about 10 degrees clockwise from west; the map suggests 297 degrees",
    "a12-sband": "ALSJ Apollo 12 flag page: the RCS hot-fire check blew the S-band antenna over (GET 140:12:11)",
    "a14-map": "ALSJ Apollo 14 EVA-1/2 traverse map on LROC M175388134R, 10 m grid (positions measured off it)",
    "a14-sband": "ALSJ Apollo 14 flag page: the RCS hot-fire check blew the S-band antenna over (GET 140:50:02)",
    "a15-psr": "Apollo 15 Preliminary Science Report fig. 5-52 and ALSJ flag page: flag about 11 m from the LM at azimuth 30, pointing azimuth 67",
    "a16-psr": "Apollo 16 Preliminary Science Report fig. 6-13 (planimetric map, scale bar on it); ALSJ: LM faced down-Sun, solar azimuth 88; LRV parked on a southerly heading",
    "a17-psr": "Apollo 17 Preliminary Science Report fig. 6-98 (planimetric map, scale bar on it); ALSJ: flag points east",
    "earth-aim": "Aimed at the Earth: the tilt and bearing follow from the site's latitude and longitude (the Earth stands near the middle of the Moon's sky)",
    "relief-map": "Crater read off the site map (position and size); depth and rim height from the fresh-crater relations of the Lunar Sourcebook (table 4.1, as the ALSJ quotes them), less for a worn crater",
    "surveyor-crater": "Surveyor Crater: about 200 m across, 15 m deep with a low rounded rim (USGS, Surveyor 3 TV observations). Its middle is derived: Surveyor 3 (LROC) lies just below the rim on the southern wall, and Intrepid stood about 25 feet from the rim (ALSJ); the middle is the point that satisfies both",
    "west-crater": "West Crater (about 190 m across; the Journal and LROC say 180 to 190): its middle 550 m from Eagle (the LROC exhibit page, Wikipedia's Tranquility Base), on the bearing of Little West seen from the flag (Pustynski and Jones, frame 5872: about 87 degrees); the boulder q4 at the foot of its outer slope is 410 m out, 30 m from the rim crest",
    "wiki-coords": "Crater middle from its published coordinates (to 0.01 degree: about 300 m) and diameter (LROC; Wikipedia's lunar crater pages for the depth)",
    "cone-map": "Cone Crater read off the ALSJ Apollo 14 traverse map on LROC M175388134R (position, and a diameter of about 330 m); depth about 75 m (the Apollo 14 reports)",
    "traverse-map": "Path simplified from the traverse map's tracks on the LROC image",
}

# Latitude and longitude of the descent stage: Wagner et al. 2017.
SITES = {
    "Apollo 11": {"ll": (0.67416, 23.47314), "h": 256.7, "hsrc": "a11-phot", "herr": 1},
    "Apollo 12": {"ll": (-3.0128, -23.4219), "h": 280, "hsrc": "a12-psr", "herr": 17},
    "Apollo 14": {"ll": (-3.64589, -17.47194), "h": 254, "hsrc": "a14-map", "herr": 8},
    "Apollo 15": {"ll": (26.13239, 3.6333), "h": 270, "hsrc": "a15-psr", "herr": 15},
    "Apollo 16": {"ll": (-8.9734, 15.5011), "h": 268, "hsrc": "a16-psr", "herr": 5},
    "Apollo 17": {"ll": (20.1911, 30.7723), "h": 270, "hsrc": "a17-psr", "herr": 15},
}


def offset(site_ll, ll):
    """East and north of the descent stage, metres, of a latitude and longitude."""
    lat0, lon0 = site_ll
    x = (ll[1] - lon0) * M_PER_DEG * math.cos(math.radians(lat0))
    y = (ll[0] - lat0) * M_PER_DEG
    return round(x, 1), round(y, 1)


def earth_aim(ll):
    """Tilt (degrees from the zenith) and compass bearing of the Earth from a place of the Moon, libration ignored."""
    lat, lon = (math.radians(v) for v in ll)
    e, n, u = (
        -math.sin(lon),
        -math.sin(lat) * math.cos(lon),
        math.cos(lat) * math.cos(lon),
    )
    return round(math.degrees(math.acos(u)), 1), round(
        math.degrees(math.atan2(e, n)) % 360, 1
    )


def crater(name, x, y, diameter, src="relief-map", err=1.5, worn=1.0, depth=None, rim=None):
    """A row of a site's relief: the bowl's depth and the rim's height from the fresh-crater relations, depth 0.196 D^1.01
    and rim 0.036 D^1.014 (D in km), times `worn` (1 for a fresh crater)."""
    km = diameter / 1000
    return {"n": name, "x": x, "y": y, "r": round(diameter / 2, 1), "d": depth if depth else round(196 * km**1.01 * worn, 1), "w": rim if rim is not None else round(36 * km**1.014 * worn, 2), "src": src, "err": err}


# The mission replay a site can hand over to (the mission's id) and the launch instant its clock counts from.
MISSIONS = {"Apollo 11": {"id": "apollo11", "launchMs": -14552880000}}   # 16 July 1969, 13:32:00 UTC (Apollo Flight Journal)


# What the ground holds besides the swell: named craters (x, y of the middle, metres east and north of the descent stage).
RELIEF = {
    "Apollo 11": [
        crater("Little West Crater", 64.5, 9.0, 28.0, "a11-map", 1.5),
        crater("West Crater", 549, 29, 190, "west-crater", 100),
        crater("Double Crater (west)", -18.0, -9.9, 14.5, "a11-map", 1.5, worn=0.5),
        crater("Double Crater (east)", -6.6, -12.7, 9.0, "a11-map", 2.0, worn=0.4),
        crater("Double Crater (south)", -15.1, -21.2, 7.6, "a11-map", 2.0, worn=0.4),
    ],
    "Apollo 12": [crater("Surveyor Crater", 124, -18, 200, "surveyor-crater", 30, depth=15, rim=1.0)],
    "Apollo 14": [crater("Cone Crater", 1146, 616, 330, "cone-map", 60, depth=75)],
    "Apollo 16": [
        crater("Crater east of the LM", 19.5, 0.0, 26.0, "a16-psr", 2.0, worn=0.5),
        crater("North Ray Crater", -632, 4651, 890, "wiki-coords", 300, depth=240),
    ],
    "Apollo 17": [
        crater("Crater east of the LM", 28.3, 4.4, 17.5, "a17-psr", 2.0, worn=0.6),
        crater("Camelot Crater", -1204, -33, 610, "wiki-coords", 150, worn=0.6),
    ],
}

# The tracks the astronauts and rovers left that the LROC images show, simplified (metres from the descent stage).
TRACKS = {
    "Apollo 11": [
        {"n": "To the retroreflector and the seismometer", "pts": [[0.3, -4.2], [1.1, -11.8], [0.3, -19.5], [-1.6, -21.7], [0.7, -28.5]]},
        {"n": "To Little West Crater", "pts": [[4, -3], [10.5, -5.0], [18.1, -6.6], [26.6, -7.4], [43.7, -5.9], [50.5, -4.2], [52, -4.6]]},
        {"n": "Back from Little West Crater", "pts": [[52, -6], [43.7, -11.8], [31.7, -17.8], [18.1, -23.7], [6.2, -28.9], [0.7, -28.5]]},
    ],
}

def polar(dist, az_deg):
    a = math.radians(az_deg)
    return round(dist * math.sin(a), 1), round(dist * math.cos(a), 1)


# Apollo 11 flag: 10.7 m from the LM centre, 7.8 m from the +Y pad (a pad is 4.28 m out: footpads 9.5 m outer edge to outer
# edge, ALSJ Apollo 12 flag page, less the pad's own width); the LM's +Y is 90 degrees to the right of its front.
def a11_flag_xy(front_az):
    d, dp, pad = 10.7, 7.8, 4.28
    u = (d * d - dp * dp + pad * pad) / (2 * pad)
    w = math.sqrt(d * d - u * u)
    return polar(d, (front_az + 90 - math.degrees(math.atan2(w, u))) % 360)


def build(data):
    sites = {s["name"]: s for s in data["sites"]}
    for name, cfg in SITES.items():
        s = sites[name]
        ll0 = cfg["ll"]
        land, lift = s["ms"], s["liftoff"]
        parts = [
            dict(
                m="lm",
                x=0,
                y=0,
                h=cfg["h"],
                src=cfg["hsrc"],
                err=cfg["herr"],
                ll=list(ll0),
                **{"from": land},
            ),
            dict(
                m="lm-ascent",
                x=0,
                y=0,
                h=cfg["h"],
                src=cfg["hsrc"],
                err=cfg["herr"],
                **{"from": land, "until": lift},
            ),
        ]

        def add(
            m,
            ll=None,
            xy=None,
            h=0,
            src="lroc",
            err=1.0,
            frm=land,
            until=None,
            state=None,
        ):
            x, y = offset(ll0, ll) if ll else xy
            p = dict(m=m, x=x, y=y, h=h, src=src, err=err)
            if ll:
                p["ll"] = list(ll)
            p["from"] = frm
            if until is not None:
                p["until"] = until
            parts.append(p)

        if name == "Apollo 11":
            fx, fy = a11_flag_xy(cfg["h"])
            add("flag", xy=(fx, fy), h=24, src="a11-phot", err=0.5, until=lift)
            add(
                "flag-down",
                xy=(fx, fy),
                h=round((cfg["h"] + 90 - 38.2) % 360, 1),
                src="a11-liftoff",
                err=0.5,
                frm=lift,
            )
            add(
                "lrrr-11",
                ll=(0.6734487, 23.47307),
                h=earth_aim((0.6734487, 23.47307))[1],
                src="lroc-laser",
                err=1.0,
            )
            add("psep", ll=(0.67322, 23.47315), h=cfg["h"], src="lroc", err=0.5)
            add("tv", xy=(-16.1, 17.6), h=135, src="a11-map", err=3.0)
        elif name == "Apollo 12":
            add("flag", xy=(-4.3, 15.0), h=0, src="a12-map", err=2.5)
            add("tv", xy=(8.6, 17.6), h=250, src="a12-map", err=3.0)
            hot = lift - (1 * 3600 + 51 * 60 + 36) * 1000
            b = earth_aim((-3.0128, -23.4219))[1]
            add("sband", xy=(0.1, 8.5), h=b, src="a12-map", err=2.0, until=hot)
            add("sband-down", xy=(0.1, 8.5), h=b, src="a12-sband", err=2.0, frm=hot)
            add("alsep", ll=(-3.0098, -23.4248), h=0, src="lroc", err=2.2)
            add("pse", ll=(-3.0099, -23.4249), h=0, src="lroc", err=2.6)
            add("surveyor", ll=(-3.0162, -23.418), h=0, src="lroc", err=2.6)
        elif name == "Apollo 14":
            add("flag", xy=(-7.9, 8.2), h=315, src="a14-map", err=2.5)
            hot = lift - (55 * 60 + 37) * 1000
            b = earth_aim((-3.64589, -17.47194))[1]
            add("sband", xy=(0.0, 9.4), h=b, src="a14-map", err=2.0, until=hot)
            add("sband-down", xy=(0.0, 9.4), h=b, src="a14-sband", err=2.0, frm=hot)
            add("tv", xy=(-0.2, 26.0), h=180, src="a14-map", err=3.0)
            add("met", xy=(-4.0, 6.4), h=20, src="a14-map", err=2.0)
            add("alsep", ll=(-3.64419, -17.47768), h=0, src="lroc", err=0.4)
            add("pse", ll=(-3.64408, -17.47767), h=0, src="lroc", err=0.4)
            add(
                "lrrr-14",
                ll=(-3.6441667, -17.4786481),
                h=earth_aim((-3.6441667, -17.4786481))[1],
                src="lroc-laser",
                err=1.0,
            )
        elif name == "Apollo 15":
            fx, fy = polar(11, 30)
            add("flag", xy=(fx, fy), h=67, src="a15-psr", err=2.0)
            add("alsep", ll=(26.13406, 3.62991), h=0, src="lroc", err=0.5)
            add("pse", ll=(26.13411, 3.6298), h=0, src="lroc", err=0.3)
            add(
                "lrrr-15",
                ll=(26.133405, 3.6285011),
                h=earth_aim((26.133405, 3.6285011))[1],
                src="lroc-laser",
                err=1.0,
            )
            add("lrv", ll=(26.13174, 3.63803), h=180, src="lroc", err=0.5)
        elif name == "Apollo 16":
            add("flag", xy=(-7.5, 12.3), h=285, src="a16-psr", err=2.5)
            add("alsep", ll=(-8.9759, 15.4986), h=0, src="lroc", err=3.0)
            add("pse", ll=(-8.9759, 15.4986), h=0, src="lroc", err=2.5)
            add("lrv", ll=(-8.9729, 15.5037), h=180, src="lroc", err=3.7)
        elif name == "Apollo 17":
            add("flag", xy=(-7.3, 15.5), h=90, src="a17-psr", err=2.5)
            add("alsep", ll=(20.1923, 30.7655), h=0, src="lroc", err=3.5)
            add("lrv", ll=(20.1896, 30.7769), h=0, src="lroc", err=3.2)
        s["parts"] = parts
        if name in MISSIONS:
            s["mission"] = MISSIONS[name]
        else:
            s.pop("mission", None)
        for key, table in (("relief", RELIEF), ("tracks", TRACKS)):
            if name in table:
                s[key] = table[name]
            else:
                s.pop(key, None)
    return data


def main():
    with open(bsm.SITES, encoding="utf-8") as fh:
        data = json.load(fh)
    build(data)
    data["sources"] = SOURCES
    if "Apollo 11 photogrammetry" not in data["credits"]:
        data["credits"] += " The Apollo parts and craters: LROC positions (Wagner et al. 2017, Icarus 283), the Apollo Lunar Surface Journal (Pustynski and Jones, Apollo 11 photogrammetry; Fincannon; the McInall planimetric maps for positions) and the Apollo Preliminary Science Reports; see SOURCES.txt."
    with open(bsm.SITES, "w", encoding="utf-8") as fh:
        fh.write(bsm.dump_compact(data))


if __name__ == "__main__":
    main()
