"""Build zimi/static/earth/asteroids-v1.bin: the main belt's brighter asteroids as orbital elements.

    python scripts/build_asteroids.py [--h-max 14]

From JPL's Small-Body Database (the SBDB Query API: public, NASA/JPL), every main-belt asteroid brighter than
absolute magnitude H 14 (about 18,000, Ceres to bodies a few kilometres across), each as six osculating elements at
one epoch, quantized to 16 bits: the 3D view (almanac-earth.js) moves each along its ellipse, so the belt is where
it is on any date it shows. Kepler's laws alone: over decades the planets' pull shifts each by a fraction of a degree.

Format, little-endian: float64 epoch (JD TT), uint32 count, then per asteroid six uint16:
a (0..AU_SPAN AU), e (0..1), i (0..180 deg), node, perihelion argument, mean anomaly (0..360 deg).
"""

import argparse
import json
import os
import struct
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "earth", "asteroids-v1.bin")
API = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
AU_SPAN = 6.0
SCALE = 65535.0


def fetch(h_max):
    q = {
        "fields": "a,e,i,om,w,ma,epoch",
        "sb-class": "MBA",
        "sb-cdata": json.dumps({"AND": ["H|LT|%g" % h_max]}),
    }
    req = urllib.request.Request(
        API + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "Zimi-build/1.0"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["data"]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--h-max", type=float, default=14.0)
    a = ap.parse_args(argv)
    rows = fetch(a.h_max)
    epochs = {}
    for r in rows:
        epochs[r[6]] = epochs.get(r[6], 0) + 1
    epoch = float(max(epochs, key=epochs.get))
    k = 0.01720209895  # Gauss's constant: mean motion n = k / a^1.5 radians a day
    out = []
    for a_, e, i, om, w, ma, ep in rows:
        a_, e, i, om, w, ma, ep = map(float, (a_, e, i, om, w, ma, ep))
        if not (0 < a_ < AU_SPAN and 0 <= e < 1):
            continue
        # Each brought to the common epoch along its own orbit.
        ma = (ma + (epoch - ep) * k / a_**1.5 * 180 / 3.141592653589793) % 360
        out.append((a_ / AU_SPAN, e, i / 180, om / 360, w / 360, ma / 360))
    with open(OUT, "wb") as f:
        f.write(struct.pack("<dI", epoch, len(out)))
        for rec in out:
            f.write(
                struct.pack(
                    "<6H", *(min(65535, max(0, int(round(v * SCALE)))) for v in rec)
                )
            )
    print(
        "%s: %d asteroids, epoch JD %.1f, %d bytes"
        % (OUT, len(out), epoch, os.path.getsize(OUT))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
